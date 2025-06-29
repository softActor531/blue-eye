const { app, BrowserWindow, Tray, nativeImage, ipcMain, desktopCapturer, screen } = require('electron');
const os = require('os');
const path = require('path');
const fs = require('fs');
const AutoLaunch = require('auto-launch');
const axios = require('axios');
const sharp = require('sharp');
const config = require('./config.json');
const { powerMonitor } = require('electron');
const dgram = require('dgram');
const client = dgram.createSocket('udp4');

let tray = null;
let win = null;
let { serverIP, intervalMs, apiPort } = config;

function setTrayStatus(color = 'gray') {
  const iconPath = path.join(__dirname, 'assets', `icon-${color}.png`);
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (tray) tray.setImage(icon);
}

function getMacAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
        return iface.mac;
      }
    }
  }
  return 'unknown';
}

function getUsername() {
  return os.userInfo().username;
}

async function compressAndConvertToWebP(pngBuffer) {
  const img = nativeImage.createFromBuffer(pngBuffer);
  const size = img.getSize();

  const width = Math.floor(size.width * 0.7);
  const height = Math.floor(size.height * 0.7);

  return await sharp(pngBuffer)
    .resize(width, height)
    .webp({ quality: config.quality || 70 })
    .toBuffer();
}

async function captureAndUpload() {
  try {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const pngBuffer = sources[0].thumbnail.toPNG();

    const compressed = await compressAndConvertToWebP(pngBuffer);
    const username = getUsername();
    const mac = getMacAddress();

    const idleTime = powerMonitor.getSystemIdleTime();
    const isActive = idleTime < (config.idleThreshold || 3);

    await axios.post(`http://${serverIP}:${apiPort}/client/upload`, compressed, {
      headers: {
        'Content-Type': 'image/webp',
        'X-Username': username,
        'X-DeviceId': mac,
        'X-Active': isActive.toString()
      }
    });

    setTrayStatus('blue'); // upload success
    // setToolTip('Connection Success.');
  } catch (err) {
    console.error('Upload failed:', err.message);
    setTrayStatus('red'); // error state
    // tray.setToolTip(`Connection failure ${err.message}`);
  }
}

ipcMain.on('hide-window', () => {
  if (win && !win.isDestroyed()) win.hide();
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  win = new BrowserWindow({
    width: 400,
    height: 300,
    show: false,
    frame: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  tray = new Tray(nativeImage.createEmpty()); // temporary placeholder
  setTrayStatus('gray'); // initial
  // tray.setToolTip('Connection not started.');

  // win.loadFile('index.html');
  // win.webContents.openDevTools();

  const autoLauncher = new AutoLaunch({ name: 'BlueEye' });
  autoLauncher.isEnabled().then(enabled => {
    if (!enabled) autoLauncher.enable();
  });

  setInterval(captureAndUpload, intervalMs || 60000);
});

client.bind(config.port);

client.on('message', (msg, rinfo) => {
  const response = msg.toString();
  if (response) {
    const jsonData = JSON.parse(response);
    serverIP = jsonData.SERVER_IP_ADDRESS || config.serverIP;
    intervalMs = jsonData.CLIENT_SCREENSHOT_INTERVAL || config.intervalMs;
    apiPort = jsonData.CLIENT_API_PORT || config.apiPort;
  }
});