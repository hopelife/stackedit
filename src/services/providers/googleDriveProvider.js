import store from '../../store';
import googleHelper from './helpers/googleHelper';
import Provider from './common/Provider';
import utils from '../utils';
import fileSvc from '../fileSvc';

export default new Provider({
  id: 'googleDrive',
  getToken(location) {
    const token = store.getters['data/googleTokensBySub'][location.sub];
    return token && token.isDrive ? token : null;
  },
  getUrl(location) {
    return `https://docs.google.com/file/d/${location.driveFileId}/edit`;
  },
  getDescription(location) {
    const token = this.getToken(location);
    return `${location.driveFileId} — ${token.name}`;
  },
  async initAction() {
    const state = googleHelper.driveState || {};
    if (state.userId) {
      // Try to find the token corresponding to the user ID
      let token = store.getters['data/googleTokensBySub'][state.userId];
      // If not found or not enough permission, popup an OAuth2 window
      if (!token || !token.isDrive) {
        await store.dispatch('modal/open', { type: 'googleDriveAccount' });
        token = await googleHelper.addDriveAccount(
          !store.getters['data/localSettings'].googleDriveRestrictedAccess,
          state.userId,
        );
      }

      const openWorkspaceIfExists = (file) => {
        const folderId = file
          && file.appProperties
          && file.appProperties.folderId;
        if (folderId) {
          // See if we have the corresponding workspace
          const workspaceParams = {
            providerId: 'googleDriveWorkspace',
            folderId,
          };
          const workspaceId = utils.makeWorkspaceId(workspaceParams);
          const workspace = store.getters['data/sanitizedWorkspacesById'][workspaceId];
          // If we have the workspace, open it by changing the current URL
          if (workspace) {
            utils.setQueryParams(workspaceParams);
          }
        }
      };

      switch (state.action) {
        case 'create':
        default:
          // See if folder is part of a workspace we can open
          try {
            const folder = await googleHelper.getFile(token, state.folderId);
            folder.appProperties = folder.appProperties || {};
            googleHelper.driveActionFolder = folder;
            openWorkspaceIfExists(folder);
          } catch (err) {
            if (!err || err.status !== 404) {
              throw err;
            }
            // We received an HTTP 404 meaning we have no permission to read the folder
            googleHelper.driveActionFolder = { id: state.folderId };
          }
          break;

        case 'open': {
          await utils.awaitSequence(state.ids || [], async (id) => {
            const file = await googleHelper.getFile(token, id);
            file.appProperties = file.appProperties || {};
            googleHelper.driveActionFiles.push(file);
          });

          // Check if first file is part of a workspace
          openWorkspaceIfExists(googleHelper.driveActionFiles[0]);
        }
      }
    }
  },
  async performAction() {
    const state = googleHelper.driveState || {};
    const token = store.getters['data/googleTokensBySub'][state.userId];
    switch (token && state.action) {
      case 'create': {
        const file = await fileSvc.createFile({}, true);
        store.commit('file/setCurrentId', file.id);
        // Return a new syncLocation
        return this.makeLocation(token, null, googleHelper.driveActionFolder.id);
      }
      case 'open':
        store.dispatch(
          'queue/enqueue',
          () => this.openFiles(token, googleHelper.driveActionFiles),
        );
        return null;
      default:
        return null;
    }
  },
  async downloadContent(token, syncLocation) {
    const content = await googleHelper.downloadFile(token, syncLocation.driveFileId);
    return Provider.parseContent(content, `${syncLocation.fileId}/content`);
  },
  async uploadContent(token, content, syncLocation, ifNotTooLate) {
    const file = store.state.file.itemsById[syncLocation.fileId];
    const name = utils.sanitizeName(file && file.name);
    const parents = [];
    if (syncLocation.driveParentId) {
      parents.push(syncLocation.driveParentId);
    }
    const driveFile = await googleHelper.uploadFile({
      token,
      name,
      parents,
      media: Provider.serializeContent(content),
      fileId: syncLocation.driveFileId,
      ifNotTooLate,
    });
    return {
      ...syncLocation,
      driveFileId: driveFile.id,
    };
  },
  async publish(token, html, metadata, publishLocation) {
    const driveFile = await googleHelper.uploadFile({
      token,
      name: metadata.title,
      parents: [],
      media: html,
      mediaType: publishLocation.templateId ? 'text/html' : undefined,
      fileId: publishLocation.driveFileId,
    });
    return {
      ...publishLocation,
      driveFileId: driveFile.id,
    };
  },
  async openFiles(token, driveFiles) {
    return utils.awaitSequence(driveFiles, async (driveFile) => {
      // Check if the file exists and open it
      if (!Provider.openFileWithLocation(store.getters['syncLocation/items'], {
        providerId: this.id,
        driveFileId: driveFile.id,
      })) {
        // Download content from Google Drive
        const syncLocation = {
          driveFileId: driveFile.id,
          providerId: this.id,
          sub: token.sub,
        };
        let content;
        try {
          content = await this.downloadContent(token, syncLocation);
        } catch (e) {
          store.dispatch('notification/error', `Could not open file ${driveFile.id}.`);
          return;
        }

        // Create the file
        const item = await fileSvc.createFile({
          name: driveFile.name,
          parentId: store.getters['file/current'].parentId,
          text: content.text,
          properties: content.properties,
          discussions: content.discussions,
          comments: content.comments,
        }, true);
        store.commit('file/setCurrentId', item.id);
        store.commit('syncLocation/setItem', {
          ...syncLocation,
          id: utils.uid(),
          fileId: item.id,
        });
        store.dispatch('notification/info', `${store.getters['file/current'].name} was imported from Google Drive.`);
      }
    });
  },
  makeLocation(token, fileId, folderId) {
    const location = {
      providerId: this.id,
      sub: token.sub,
    };
    if (fileId) {
      location.driveFileId = fileId;
    }
    if (folderId) {
      location.driveParentId = folderId;
    }
    return location;
  },
});
