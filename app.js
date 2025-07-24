const { app, BrowserWindow, Tray, nativeImage, ipcMain, desktopCapturer, screen } = require('electron');
const os = require('os');
const path = require('path');
const Store = require('electron-store').default;
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const config = require('./config.json');
const { powerMonitor } = require('electron');
const dgram = require('dgram');
const client = dgram.createSocket('udp4');
const localVersion = require('./package.json').version;
const sudo = require('sudo-prompt');

const store = new Store();
const hostsPath = process.platform === 'win32'
  ? path.join(process.env.SystemRoot, 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts';

const options = {
  name: 'Sinzo Client',
};

let tray = null;
let win = null, isRegistered = true;
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

function getLocalIP() {
  const interfaces = os.networkInterfaces();

  for (const [name, ifaceList] of Object.entries(interfaces)) {
    const lowerName = name.toLowerCase();

    // Only proceed if interface looks like Ethernet or en0 (wired connection)
    if (!(lowerName.includes('ethernet') || lowerName === 'en0')) continue;

    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log("Local IP found:", iface.address, "on", name);
        return iface.address;
      }
    }
  }

  // Fallback: return first non-internal IPv4 if no Ethernet found
  for (const ifaceList of Object.values(interfaces)) {
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        console.log("Fallback IP:", iface.address);
        return iface.address;
      }
    }
  }

  return '127.0.0.1';
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

async function blockSitesIfNotMatched() {
  try {
    const { data } = await axios.get(`http://${serverIP}:${apiPort}/client/blocklist`);

    if (data.version && data.blocklist) {
      const config = `### blueeye config ${data.version}`;
      const content = fs.readFileSync(hostsPath, 'utf8');
      if (!content.includes(config)) {
        const blockList = data.blocklist.map(blockSite => `${blockSite.redirect} ${blockSite.url}`);
        const joined = `${os.EOL}${os.EOL}${config}${os.EOL}${blockList.join(os.EOL)}${os.EOL}`;

        const cmd = process.platform === 'win32'
          ? `echo ${joined.replace(/\n/g, ' & echo ')} >> "${hostsPath}"`
          : `echo "${joined}" | tee -a ${hostsPath}`;

        sudo.exec(cmd, options, (error, stdout, stderr) => {
          if (error) {
            console.error('Failed to modify hosts file:', error);
          }
        });
      }
    }
  } catch (err) {
    console.error('Cannot read or write hosts file:', err.message);
  }
}

async function applyRouterAddress(newGateway) {
  const net = getCurrentNetworkConfig();
  if (!net) {
    console.error('Unable to determine network config.');
    return;
  }

  const { interfaceName, ip, subnet } = net;
  const options = { name: 'Sinzo Client' };
  let cmd;

  if (process.platform === 'win32') {
    cmd = `netsh interface ip set address name="${interfaceName}" static ${ip} ${subnet} ${newGateway}`;
  } else {
    cmd = `networksetup -setmanual ${getMacNetworkServiceName(interfaceName)} ${ip} ${subnet} ${newGateway}`;
  }

  sudo.exec(cmd, options, (error, stdout, stderr) => {
    if (error) {
      console.error('Failed to change router address:', error.message);
    }
  });
}

function getMacNetworkServiceName(interfaceName) {
  const map = {
    en0: 'Ethernet',
    en1: 'Wi-Fi',
  };
  return map[interfaceName] || interfaceName;
}

function getCurrentNetworkConfig() {
  const interfaces = os.networkInterfaces();
  for (const name in interfaces) {
    for (const iface of interfaces[name]) {
      if (
        iface.family === 'IPv4' &&
        !iface.internal &&
        iface.address &&
        iface.netmask
      ) {
        return {
          interfaceName: name,
          ip: iface.address,
          subnet: iface.netmask,
        };
      }
    }
  }
  return null;
}

async function fetchAndDisplayRouters() {
  try {
    const mac = getMacAddress();
    const { data } = await axios.get(`http://${serverIP}:${apiPort}/client/routers`, {
      headers: {
        'X-DeviceId': mac
      }
    });
    if (Array.isArray(data)) {
      win.webContents.send('router-list', data);
    }
  } catch (error) {
    console.error('Failed to fetch routers:', error);
  }
}

ipcMain.on('select-router', (event, ip) => {
  applyRouterAddress(ip);
});

ipcMain.handle('set-device-id', (event, id) => {
  if (typeof id === 'string' && id.trim()) {
    store.set('deviceId', id.trim());
  }
});

ipcMain.handle('get-device-id', () => {
  return store.get('deviceId') || '';
});

async function captureAndUpload() {
  try {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    if (!width || !height) return;

    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const imgData = {};
    for (let i = 0; i < sources.length; i++) {
      if (sources[i]) {
        const pngBuffer = sources[i].thumbnail.toPNG();
        const compressed = await compressAndConvertToWebP(pngBuffer);
        imgData[`screen${i}`] = compressed;
      }
    }
    imgData.count = sources.length;

    if (imgData) {
      const username = getUsername();
      const mac = getMacAddress();

      const idleTime = powerMonitor.getSystemIdleTime();
      const isActive = idleTime < (config.idleThreshold || 3);
      axios.post(`http://${serverIP}:${apiPort}/client/upload`, imgData, {
        headers: {
          'Content-Type': 'application/json',
          'X-Username': username,
          'X-DeviceId': mac,
          'X-UserId': store.get('deviceId') || '',
          'X-Active': isActive.toString(),
          'X-LocalIP': getLocalIP()
        }
      });
      setTrayStatus(isRegistered ? 'blue': 'red');
      // setToolTip('Connection Success.');
    }
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
    width: 500,
    height: 400,
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

  tray.on('click', () => {
    if (win) {
      app.focus();
      win.show();
      win.focus();
    }
  });

  win.loadFile('index.html');
  // win.webContents.openDevTools({ mode: 'detach' });

  win.on('close', (event) => {
    event.preventDefault();
    win.hide();
  });

  let appPath;
  if (process.platform === 'darwin') {
    appPath = process.execPath;
  } else {
    appPath = app.getPath('exe');
  }

  app.setLoginItemSettings({
    openAtLogin: true,
    path: appPath,
    args: ['--hidden']
  });

  blockSitesIfNotMatched();
  setInterval(captureAndUpload, intervalMs || 60000);
});

client.bind(config.port);

client.on('message', (msg, rinfo) => {
  const response = msg.toString();
  if (response) {
    const jsonData = JSON.parse(response);

    isRegistered = !jsonData.freeLaptops?.includes(getMacAddress());

    const newServerIp = jsonData.SERVER_IP_ADDRESS || config.serverIP;
    if (newServerIp !== serverIP) {
      serverIP = newServerIp;
      blockSitesIfNotMatched();
      fetchAndDisplayRouters();
    };
    intervalMs = jsonData.CLIENT_SCREENSHOT_INTERVAL || config.intervalMs;
    apiPort = jsonData.CLIENT_API_PORT || config.apiPort;
    const remoteVersion = jsonData.CLIENT_APP_VERSION || localVersion;

    if (remoteVersion !== localVersion) {
      if (win && win.webContents) {
        win.webContents.send('version-mismatch', {
          local: localVersion,
          remote: remoteVersion,
          serverIP: serverIP
        });
      }
      win.show();
    }
  }
});


