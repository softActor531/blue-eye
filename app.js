const { app, BrowserWindow, Tray, nativeImage, ipcMain, desktopCapturer, screen, powerMonitor } = require('electron');
const os = require('os');
const path = require('path');
const Store = require('electron-store').default;
const fs = require('fs');
const axios = require('axios');
const sharp = require('sharp');
const dgram = require('dgram');
const sudo = require('sudo-prompt');
const crypto = require('crypto');
const { execSync, exec, spawn } = require('child_process');
const si = require('systeminformation');
const elevated = require('elevated');

const localVersion = require('./package.json').version;
const config = require('./config.json');
const { installAudioDriver, isDriverInstalled, setUpSinzoAudioDriver } = require("./utils/driverInstaller");
const { startRecording, stopRecording } = require('./recording');

const isDev = !app.isPackaged;
const store = new Store();
const platform = os.platform();
const hostsPath = platform === 'win32'
  ? path.join(process.env.SystemRoot, 'System32', 'drivers', 'etc', 'hosts')
  : '/etc/hosts';

const client = dgram.createSocket('udp4');
const callSocket = dgram.createSocket('udp4');

let tray = null, flashInterval = null, isFlashing = false;;
let win = null, isRegistered = true;
let { serverIP, apiPort, intervalMs, callSocketPort, metadataIntervalMs } = config;
let system = null, osInfo = null, disks = null, installDate = 'unknown';
let uploadInterval = null, metaDataInterval = null;
let isRecording = false;
let metaData = {};

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
  process.chdir(os.homedir());
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


// Tray Icon Functions
let lastTrayColor = null;
function setTrayStatus(color = 'gray') {
  if (lastTrayColor === color) return;
  lastTrayColor = color;

  const iconPath = path.join(__dirname, 'assets', `icon-${color}.png`);
  const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
  if (tray) tray.setImage(icon);
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

// Get PC Info Functions
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

async function updateMetaData() {
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

  metaData = {
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

// Image Processing
async function compressAndConvertToWebP(pngBuffer) {
  const metadata = await sharp(pngBuffer).metadata();
  const width = Math.floor(metadata.width * 0.7);
  const height = Math.floor(metadata.height * 0.7);

  return sharp(pngBuffer)
    .resize(width, height)
    .webp({ quality: config.quality || 70 })
    .toBuffer();
}

async function captureAndUpload() {
  try {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    if (!width || !height) return;
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height }
    });
    const imgData = {};
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (source && source.thumbnail) {
        const pngBuffer = source.thumbnail.toPNG();
        const webpBuffer = await compressAndConvertToWebP(pngBuffer);
        imgData[`screen${i}`] = webpBuffer;
      }
    }

    imgData.count = sources.length;
    imgData.metaData = metaData;
    if (imgData.count > 0) {
      axios.post(`http://${serverIP}:${apiPort}/client/upload`, imgData, {
        headers: {
          'Content-Type': 'application/json',
        }
      }).then(() => {
        setTrayStatus(isRegistered ? 'blue' : 'red');
      }).catch(_ => {
        setTrayStatus('red');
      });
    }
  } catch (_) {
    setTrayStatus('red');
  }
}

async function blockSitesIfNotMatched() {
  try {
    const { data } = await axios.get(`http://${serverIP}:${apiPort}/client/blocklist`);

    if (data.version && data.blocklist) {
      const config = `### blueeye config ${data.version}`;
      const content = fs.readFileSync(hostsPath, 'utf8');
      if (!content.includes(config)) {
        const blockList = data.blocklist.map(blockSite => `${blockSite.redirect} ${blockSite.url}`);
        const joined = [
          '',
          '',
          configHeader,
          ...blockList,
          ''
        ].join(os.EOL);

        const tempFilePath = path.join(os.tmpdir(), 'blueeye_hosts_append.txt');
        fs.writeFileSync(tempFilePath, joined, 'utf8');

        const cmd = platform() === 'win32'
          ? `type "${tempFilePath}" >> "${hostsPath}"`
          : `cat "${tempFilePath}" | tee -a "${hostsPath}"`;

        const options = { name: 'Wite' };
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
// Router Functions
async function fetchAndDisplayRouters() {
  try {
    const mac = getMacAddress();
    const { data } = await axios.get(`http://${serverIP}:${apiPort}/client/routers`, {
      headers: {
        'X-DeviceId': mac
      }
    });
    if (Array.isArray(data)) {
      win.webContents.send('router-list', data, store.get('routerAddress') || '');
    }
  } catch (error) {}
}
async function applyRouterAddress(newGateway) {
  await axios.post(`http://${serverIP}:${apiPort}/client/set-router`, {
    gateway: newGateway,
    localIp: getLocalIP(),
  }).catch(err => {});
  store.set('routerAddress', newGateway);
  fetchAndDisplayRouters();
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
    const approved = await requestApproval(macAddress);
    if (approved) {
      unmuteMic();
      startRecording();
      isRecording = true;
      return { status: 'started' };
    } else {
      return { status: 'denied' };
    }
  } else {
    isRecording = false;
    await stopRecording(`http://${serverIP}:${apiPort}/client/recordings`, getMacAddress());
    muteMic();
    return { status: 'stopped' };
  }
});

ipcMain.on('hide-window', () => {
  if (win && !win.isDestroyed()) win.hide();
});

app.whenReady().then(async () => {
  if (platform === 'darwin') app.dock.hide();
  win = new BrowserWindow({
    title: `Wite v${localVersion}`,
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
    await installAudioDriver();
  } else {
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
  await updateMetaData();
  metaDataInterval = setInterval(updateMetaData, metadataIntervalMs);
  uploadInterval = setInterval(captureAndUpload, intervalMs || 5000);
  blockSitesIfNotMatched();
  if (platform === 'win32') {
    disableUSBStoragesForWindows();
  }
  setInterval(ejectUSBDisks, 10000);
  setInterval(checkMemoryAndRestart, 30000);
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
  if (process.platform === 'win32') {
    const options = {
      name: 'Wite',
    };
    const cmd = `reg add "HKLM\\SYSTEM\\CurrentControlSet\\Services\\USBSTOR" /v Start /t REG_DWORD /d 4 /f`;

    sudo.exec(cmd, options, (error, stdout, stderr) => {
      if (error) {
        console.error('❌ Failed to disable USB storage:', error);
      } else {
        console.log('✅ USB storage disabled.');
      }
    });
  }
}

function requestApproval(macAddress) {
  return new Promise((resolve) => {
    const message = Buffer.from(JSON.stringify({ type: 'approval-request', mac: macAddress }));
    callSocket.send(message, 0, message.length, callSocketPort, serverIP, (err) => {
      if (err) {
        resolve(false);
      }
    });

    // Listen for approval response from server
    const approvalHandler = (msg) => {
      try {
        const data = JSON.parse(msg.toString());
        if (data.type === 'approval-response') {
          clearTimeout(timeout);
          client.removeListener('message', approvalHandler);
          resolve(data.approved === true);
        }
      } catch (e) {}
    };
    const timeout = setTimeout(() => {
      client.removeListener('message', approvalHandler);
      resolve(false);
    }, 20000);
    callSocket.on('message', approvalHandler);
  });
}

const appName = process.platform === 'darwin' ? 'Sinzo-Client' : 'Sinzo-Client.exe';

async function getAppMemoryUsageMB() {
  const processes = await psList();
  const targetProcesses = processes.filter(p => p.name.includes(appName));
  if (targetProcesses.length === 0) {
    console.log('🟡 App process not found.');
    return 0;
  }
  let totalMemory = 0;
  for (const proc of targetProcesses) {
    try {
      const stats = await pidusage(proc.pid);
      totalMemory += stats.memory;
    } catch (err) {
      console.error(`Failed to get memory for PID ${proc.pid}`, err);
    }
  }
  return totalMemory / 1024 / 1024;
}

async function checkMemoryAndRestart() {
  const usedMB = await getAppMemoryUsageMB();
  console.log(`🔍 Total app memory used: ${usedMB.toFixed(2)} MB`);

  if (usedMB > 4096) {
    console.warn('Memory exceeded 4GB. Restarting...');
    app.relaunch({ execPath: process.execPath });
    app.exit(0);
  }
}