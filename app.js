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
const localVersion = require('./package.json').version;
const sudo = require('sudo-prompt');
const crypto = require('crypto');
const { execSync } = require('child_process');
const si = require('systeminformation');
const { exec } = require('child_process');
const { installAudioDriver, isDriverInstalled, setUpSinzoAudioDriver } = require("./utils/driverInstaller");
const { startRecording, stopRecording } = require('./recording');
const isDev = require('electron-is-dev');
const { spawn } = require('child_process');
const elevated = require('elevated');

const store = new Store();
const platform = os.platform();
const hostsPath = platform === 'win32'
  ? path.join(process.env.SystemRoot, 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts';

const options = {
  name: 'Sinzo Client',
};
const client = dgram.createSocket('udp4');
const callSocket = dgram.createSocket('udp4');

let tray = null, flashInterval = null, isFlashing = false;;
let win = null, isRegistered = true;
let { serverIP, apiPort, intervalMs, callSocketPort } = config;
let system = null, osInfo = null, disks = null, installDate = 'unknown';
let uploadInterval = null;
let isRecording = false;

function setTrayStatus(color = 'gray') {
  const iconPath = path.join(__dirname, 'assets', `icon-${color}.png`);
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (tray) tray.setImage(icon);
}

// Microphone mute/unmute functions
let installerDir;
if (isDev) {
  installerDir = path.join(__dirname, './installers');
} else {
  installerDir = path.join(process.resourcesPath, 'installers');
}

const helperPath = path.join(installerDir, 'micVolumeHelper');

try {
  process.cwd();
} catch (err) {
  const os = require('os');
  process.chdir(os.homedir()); // fallback to home dir if cwd is broken
}

function muteMic() {
  if (platform === 'darwin') {
    const proc = spawn(helperPath, ['mute']);
    proc.on('close', (code) => {
      console.log(`micVolumeHelper mute exited with code ${code}`);
    });
  } else if (platform === 'win32') {
    const psScript = path.join(__dirname, 'scripts', 'disable-mics.ps1');
    const command = `powershell -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${psScript}\\"'"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Failed to disable microphones: ${stderr}`);
      } else {
        console.log(`Microphones disabled successfully.`);
      }
    });
  }
}
async function unmuteMic() {
  if (platform === 'darwin') {
    const proc = spawn(helperPath, ['unmute']);
    proc.on('close', (code) => {
      console.log(`micVolumeHelper unmute exited with code ${code}`);
    });
  } else if (platform === 'win32') {
    const psScript = path.join(__dirname, 'scripts', 'enable-mics.ps1');
    const command = `powershell -ExecutionPolicy Bypass -WindowStyle Hidden -Command "Start-Process powershell -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File \\"${psScript}\\"'"`;

    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`Failed to enable microphones: ${stderr}`);
      } else {
        console.log(`Microphones enabled successfully.`);
      }
    });
  }
}

function startFlashingTray() {
  if (isFlashing) return;

  let toggle = false;
  flashInterval = setInterval(() => {
    setTrayStatus(toggle ? 'red' : 'blue');
    toggle = !toggle;
  }, 500);

  isFlashing = true;
}

function stopFlashingTray(icon) {
  clearInterval(flashInterval);
  setTrayStatus('blue');
  isFlashing = false;
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

    if (!(lowerName.includes('ethernet') || lowerName === 'en0')) continue;

    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  for (const ifaceList of Object.values(interfaces)) {
    for (const iface of ifaceList) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }

  return '127.0.0.1';
}
function getMacInstallDate() {
  const output = execSync(
    `stat -f "%SB" -t "%Y-%m-%d %H:%M:%S" /private/var/db/.AppleSetupDone`,
    { encoding: 'utf8' }
  );
  return output.slice(0, -1);
}

async function getOsInstallDate() {
  try {
    if (platform === 'win32') {
      const output = execSync('powershell -Command "(Get-WmiObject -Class Win32_OperatingSystem).InstallDate"').toString();
      const match = output.match(/InstallDate=(\d{14})/);
      if (match) {
        const raw = match[1];
        const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}T${raw.slice(8, 10)}:${raw.slice(10, 12)}:${raw.slice(12, 14)}Z`;
        return new Date(formatted).toISOString();
      }
    } else if (platform === 'darwin') {
      return getMacInstallDate();
    } else if (platform === 'linux') {
      const output = execSync('sudo tune2fs -l $(df / | tail -1 | awk \'{print $1}\') | grep "Filesystem created"')
        .toString()
        .trim();
      const dateStr = output.split(':').slice(1).join(':').trim();
      const parsed = new Date(dateStr);
      if (!isNaN(parsed)) return parsed.toISOString();
    }
  } catch (err) {
    console.error('Failed to detect OS install date:', err.message);
  }

  return null;
}

async function getMetaData() {
  const primaryDisk = disks[0] || {};

  const idSource = JSON.stringify({
    serial: system.serial,
    manufacturer: system.manufacturer,
    model: system.model,
    osPlatform: osInfo.platform,
    osVersion: osInfo.build,
    diskSerial: primaryDisk.serialNum || '',
    diskSize: primaryDisk.size || '',
  });

  const nodeId = crypto.createHash('sha256').update(idSource).digest('hex');

  // Get frontmost application
  let activeApp = 'unknown';
  try {
    if (platform === 'win32') {
      const script = `
        Add-Type @"
        using System;
        using System.Runtime.InteropServices;
        public class User32 {
          [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
          [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
        }
"@
        $hwnd = [User32]::GetForegroundWindow()
        $text = New-Object -TypeName System.Text.StringBuilder -ArgumentList 256
        [User32]::GetWindowText($hwnd, $text, $text.Capacity) | Out-Null
        $text.ToString()
      `;
      activeApp = execSync(`powershell -Command "${script}"`).toString().trim();
    } else if (platform === 'darwin') {
      activeApp = execSync(
        'osascript -e \'tell application "System Events" to get name of first application process whose frontmost is true\''
      ).toString().trim();
    }
  } catch (err) {
    console.warn('Failed to get active window:', err.message);
  }

  // Get Chrome tabs (only on Mac)
  let chromeTabs = [];
  try {
    if (platform === 'darwin') {
      chromeTabs = execSync(
        `osascript -e 'tell application "Google Chrome" to get URL of tabs of windows'`
      )
        .toString()
        .trim()
        .split(', ')
        .filter(Boolean);
    }
  } catch (e) {
    console.warn('Chrome tab read failed:', e.message);
  }
  const idleTime = powerMonitor.getSystemIdleTime();
  const isActive = idleTime < (config.idleThreshold || 3);

  return {
    nodeId,
    installDate,
    system: {
      manufacturer: system.manufacturer,
      model: system.model,
      serial: system.serial,
    },
    os: {
      platform: osInfo.platform,
      distro: osInfo.distro,
      build: osInfo.build,
      arch: osInfo.arch,
    },
    disk: {
      model: primaryDisk.name,
      type: primaryDisk.type,
      serial: primaryDisk.serialNum,
      size: primaryDisk.size,
      interface: primaryDisk.interfaceType,
      smartStatus: primaryDisk.smartStatus,
    },
    activeApp,
    chromeTabs,
    username: os.userInfo().username,
    deviceId: getMacAddress(),
    userId: store.get('deviceId') || '',
    active: isActive.toString(),
    localIP: getLocalIP()
  };
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

        const cmd = platform === 'win32'
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
  await axios.post(`http://${serverIP}:${apiPort}/client/set-router`, {
    gateway: newGateway,
    localIp: getLocalIP(),
  }).catch(err => {
    console.error('Failed to apply router address:', err.message);
  });
  console.log(`Router address applied: ${newGateway}`);
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

ipcMain.handle('toggle-recording', async () => {
  const macAddress = getMacAddress();

  if (!isRecording) {
    console.log('Requesting approval for recording...');
    const approved = await requestApproval(macAddress);
    if (approved) {
      console.log('Approved! Starting recording...');
      unmuteMic();
      startRecording();
      isRecording = true;
      return { status: 'started' };
    } else {
      console.log('Not approved to record.');
      return { status: 'denied' };
    }
  } else {
    console.log('Stopping recording and muting mic...');
    isRecording = false;
    await stopRecording(`http://${serverIP}:${apiPort}/client/recordings`, getMacAddress());
    muteMic();
    return { status: 'stopped' };
  }
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
    const metaData = await getMetaData();
    imgData.metaData = metaData;

    if (imgData) {
      axios.post(`http://${serverIP}:${apiPort}/client/upload`, imgData, {
        headers: {
          'Content-Type': 'application/json',
        }
      }).then(() => {
      });
      setTrayStatus(isRegistered ? 'blue' : 'red');
      // setToolTip('Connection Success.');
    }
  } catch (err) {
    // console.error('Upload failed:', err.message);
    setTrayStatus('red'); // error state
    // tray.setToolTip(`Connection failure ${err.message}`);
  }
}

ipcMain.on('hide-window', () => {
  if (win && !win.isDestroyed()) win.hide();
});

app.whenReady().then(async () => {
  if (platform === 'darwin') app.dock.hide();
  win = new BrowserWindow({
    title: `Sinzo Client v${localVersion}`,
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
  
  const driverInstalled = await isDriverInstalled();
  if (!driverInstalled) {
    console.log("Audio driver missing - installing...");
    await installAudioDriver();
  } else {
    console.log("Audio driver already installed.");
    if (platform === 'darwin') {
      setUpSinzoAudioDriver();
    }
  }

  tray = new Tray(nativeImage.createEmpty()); // temporary placeholder
  setTrayStatus('gray'); // initial

  muteMic();
  system = await si.system();
  osInfo = await si.osInfo();
  disks = await si.diskLayout();
  installDate = await getOsInstallDate();
  // monitorMicActivityViaFFmpeg();
  // setInterval(() => {
  //   const micActive = isMicActive();

  //   if (micActive && !micWasActive) {
  //     outputFile = path.join(app.getPath('userData'), `mic_record_${Date.now()}.mp3`);
  //     startRecording(outputFile);
  //   }

  //   if (!micActive && micWasActive) {
  //     stopRecording();
  //   }

  //   micWasActive = micActive;
  // }, 3000);

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
  if (platform === 'darwin') {
    appPath = process.execPath;
  } else {
    appPath = app.getPath('exe');
  }

  app.setLoginItemSettings({
    openAtLogin: true,
    path: appPath,
    args: ['--hidden']
  });

  uploadInterval = setInterval(captureAndUpload, intervalMs || 5000);
  blockSitesIfNotMatched();

  if (platform === 'win32') {
    disableUSBStoragesForWindows();
  }

  setInterval(ejectUSBDisks, 10000);
});

function ejectUSBDisks() {
  if (platform !== 'darwin') return;

  exec("diskutil list external | grep '/dev/disk' | awk '{print $1}'", (err, stdout) => {
    if (err) {
      console.error('Error listing external disks:', err);
      return;
    }

    const disks = stdout.trim().split('\n').filter(Boolean);
    disks.forEach((disk) => {
      exec(`diskutil eject ${disk}`, (ejectErr, ejectOut) => {
        if (ejectErr) {
          console.warn(`Failed to eject ${disk}:`, ejectErr.message);
        } else {
          console.log(`Ejected ${disk}:`, ejectOut);
        }
      });
    });
  });
}

client.bind(config.port);
callSocket.bind(callSocketPort);

client.on('message', async (msg, rinfo) => {
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
    if (jsonData.CLIENT_SCREENSHOT_INTERVAL) {
      intervalMs = jsonData.CLIENT_SCREENSHOT_INTERVAL;
      if (uploadInterval) {
        clearInterval(uploadInterval);
      }
      uploadInterval = setInterval(captureAndUpload, intervalMs);
    }
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
      startFlashingTray();
    } else {
      stopFlashingTray();
    }
  }
});

function disableUSBStoragesForWindows() {
  if (platform === 'win32') {
    // Command to disable USB storage
    const cmd = 'sc config USBSTOR start= disabled && sc stop USBSTOR';

    // Use the 'elevated' module to run the command as Administrator
    elevated.exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to disable USB storage on Windows:', error);
      } else {
        console.log('USB storage devices disabled on Windows.');
      }
    });
  } else {
    console.warn('USB storage blocking is not supported on this OS.');
  }
}

function enableUSBStorageDevices() {
  if (platform === 'win32') {
    // Enable USBSTOR service (blocks USB storage, not audio/camera)
    const cmd = `sc config USBSTOR start= demand && sc start USBSTOR`;
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        console.error('Failed to enable USB storage on Windows:', error);
      } else {
        console.log('USB storage devices enabled on Windows.');
      }
    });
  } else {
    console.warn('USB storage enabling is not supported on this OS.');
  }
}

function requestApproval(macAddress) {
  return new Promise((resolve) => {
    const message = Buffer.from(JSON.stringify({ type: 'approval-request', mac: macAddress }));
    callSocket.send(message, 0, message.length, callSocketPort, serverIP, (err) => {
      if (err) {
        console.error('Failed to send approval request:', err);
        resolve(false);
      }
    });

    // Listen for approval response from server
    const approvalHandler = (msg, rinfo) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'approval-response') {
          client.removeListener('message', approvalHandler);
          resolve(data.approved === true);
        }
      } catch (e) {
        // ignore invalid JSON
      }
    };

    callSocket.on('message', approvalHandler);

    // Timeout after 10s
    setTimeout(() => {
      client.removeListener('message', approvalHandler);
      resolve(false);
    }, 20000);
  });
}