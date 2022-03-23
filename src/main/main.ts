/* eslint global-require: off, no-console: off, promise/always-return: off, no-restricted-syntax: off, yoda: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import os from 'os';
import { globSource } from 'ipfs-core';
import * as Ctl from 'ipfsd-ctl';
import { app, BrowserWindow, shell, ipcMain, dialog } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import fs from 'fs';
import MenuBuilder from './menu';

import { resolveHtmlPath } from './util';

const CID = require('cids');

//* Run go-ipfs node locally as subprocess

const port = 9090;

const server = Ctl.createServer(
  port,
  {
    ipfsHttpModule: require('ipfs-http-client'),
  },
  {
    go: {
      ipfsBin: require('go-ipfs').path(),
    },
  }
);

//* don't know what this is
//* it's from react-electron boilerplate
export default class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow;
let ipfsNode: any;
let ipfsd: any;

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDevelopment =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDevelopment) {
  require('electron-debug')();
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions = ['REACT_DEVELOPER_TOOLS'];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload
    )
    .catch(console.log);
};

const createWindow = async () => {
  if (isDevelopment) {
    await installExtensions();
  }

  const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

  const getAssetPath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
  };
  try {
    //* starting server for go-ipfs as subprocess
    await server.start();
    //* controller for IPFS API

    // const factory = Ctl.createFactory({
    //   ipfsHttpModule: require('ipfs-http-client'),
    //   ipfsBin: require('go-ipfs').path(),
    //   remote: false,
    //   endpoint: `http://localhost:${port}`, // or you can set process.env.IPFSD_CTL_SERVER to http://localhost:9090
    //   ipfsOptions: {
    //     repo: path.join(os.homedir(), '.buildnode'),
    //     config: {
    //       Datastore: {
    //         GCPeriod: '1h',
    //         StorageGCWatermark: 99,
    //         //* max storage
    //         StorageMax: '350GB',
    //       },
    //     },
    //   },
    // });
    // ipfsd = await factory.spawn();

    ipfsd = await Ctl.createController({
      remote: false,
      test: false,
      disposable: false,
      ipfsHttpModule: require('ipfs-http-client'),
      ipfsBin: require('go-ipfs')
        .path()
        .replace('app.asar', 'app.asar.unpacked'),
      endpoint: `http://localhost:${port}`,
      ipfsOptions: {
        repo: path.join(os.homedir(), '.buildnode'),
        config: {
          Datastore: {
            GCPeriod: '1h',
            StorageGCWatermark: `99`,
            StorageMax: '350GB',
          },
        },
      },
    });
    await ipfsd.init();
    await ipfsd.start();

    ipfsNode = ipfsd.api;
    await ipfsNode.id();
    //* Create local folder for MFS
    try {
      await ipfsNode.files.mkdir('/');
      console.log('Congrats! Directory is created');
    } catch (er) {
      console.log('Local directory already created');
    }
  } catch (err) {
    console.log(err);
    log.warn(err);
  }

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: true,
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.webContents.openDevTools();

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    if (process.env.START_MINIMIZED) {
      mainWindow.minimize();
    } else {
      mainWindow.show();
    }
  });

  mainWindow.on('closed', async () => {
    await ipfsd.stop();
    await server.stop();
    mainWindow.destroy();
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

//* UPLOADS
const getAllFiles = function (dirPath: string, _arrayOfFiles: Array<string>) {
  const files = fs.readdirSync(dirPath);

  let arrayOfFiles: Array<string> = _arrayOfFiles || [];

  files.forEach(function (file) {
    if (fs.statSync(path.join(dirPath, file)).isDirectory()) {
      arrayOfFiles = getAllFiles(path.join(dirPath, file), arrayOfFiles);
    } else {
      arrayOfFiles.push(path.join(dirPath, file));
    }
  });

  return arrayOfFiles;
};

ipcMain.on('open-select-folder-dialog', async (event) => {
  try {
    const folder = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
    });
    let uploadedSize = 0n;
    let curSize = 0n;
    let cid = '';
    let prevSize = 0n;
    const pathToFolder = folder.filePaths[0];
    const splitted = pathToFolder.split('/');
    const folderName = splitted[splitted.length - 1];
    for await (const currentFile of ipfsNode.addAll(
      globSource(pathToFolder, '**/*'),
      {
        pin: true,
        wrapWithDirectory: true,
        progress: (size: bigint) => {
          prevSize = curSize;
          curSize = BigInt(size);
          if (
            prevSize > curSize ||
            //* some weird shit w/ bigint
            (-24254n <= curSize - prevSize && curSize - prevSize <= 24254n)
          ) {
            uploadedSize += prevSize;
            console.log(uploadedSize);
          }
        },
      }
    )) {
      console.log(currentFile);
      cid = currentFile.cid;
    }
    uploadedSize += curSize;
    await ipfsNode.files.cp(cid, `/${folderName}`, { parents: true });
    console.log(uploadedSize);
    console.log(folder);
    event.returnValue = cid.toString();
  } catch (err) {
    console.log(err);
    log.warn(err);
  }
});

ipcMain.on('open-select-file-dialog', async (event) => {
  try {
    const file = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
    });
    const pathToFile = file.filePaths[0];
    const splitted = pathToFile.split('/');
    const fileName = splitted[splitted.length - 1];
    const readStream = fs.createReadStream(pathToFile);
    const addedFile = await ipfsNode.add(readStream, {
      pin: true,
      progress: (size: bigint) => {
        console.log(size);
      },
    });
    await ipfsNode.files.cp(addedFile.cid, `/${fileName}`, { parents: true });
    console.log(file);
    console.log(addedFile.cid.toString());
    event.returnValue = addedFile.cid.toString();
  } catch (err) {
    console.log(err);
    log.warn(err);
  }
});

//* MFS API

ipcMain.on('mfs-content', async (event) => {
  const args: any[] = [];
  for await (const file of ipfsNode.files.ls('/')) {
    args.push({ name: file.name, cid: file.cid.toString() });
  }
  event.returnValue = args;
});

ipcMain.on('mfs-delete', async (event, _path, cid) => {
  try {
    const cidObj = new CID(cid);
    await ipfsNode.files.rm(_path, { recursive: true });
    const args: any[] = [];
    for await (const file of ipfsNode.files.ls('/')) {
      args.push({ name: file.name, cid: file.cid.toString() });
    }
    await ipfsNode.pin.rm(cidObj);
    for await (const res of ipfsNode.repo.gc()) {
      console.log(res);
    }
    event.returnValue = args;
  } catch (err) {
    console.log(err);
  }
});

/**
 * Add event listeners...
 */

app.on('window-all-closed', async () => {
  // Respect the OSX convention of having the application in memory even
  // after all windows have been closed
  await ipfsNode.stop();
  await ipfsd.stop();
  await server.stop();

  app.quit();
});

app.on('before-quit', async (event) => {
  await ipfsNode.stop();
  await ipfsd.stop();
  await server.stop();
});

app.on('will-quit', async (event) => {
  await ipfsNode.stop();
  await ipfsd.stop();
  await server.stop();
});

app
  .whenReady()
  .then(() => {
    createWindow();
    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
