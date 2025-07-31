const path = require("path");
const os = require("os");
const fs = require("fs");
const sudo = require("sudo-prompt");
const { app } = require('electron');
const isDev = !app.isPackaged;
const { dialog } = require('electron');
const { execSync, exec } = require("child_process");
const si = require('systeminformation');

async function isDriverInstalled() {
  const platform = os.platform();
  if (platform === "darwin") {
    return fs.existsSync("/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver");
  } else if (platform === "win32") {
    // const command = `powershell -Command "Get-WmiObject -Class Win32_SoundDevice"`;
    // const audioDevices = execSync(command, { encoding: 'utf8' });
    // console.log(audioDevices);

    // return audioDevices.includes('VB-Audio Virtual Cable');
    const devices = await si.audio();
    console.log("devices ", devices);
    const found = devices.some(device => 
      device.name.toLowerCase().includes('vb-audio') ||
      device.name.toLowerCase().includes('vb-cable')
    );

    if (found) {
      console.log('✅ VB-Audio Cable is installed.');
    } else {
      console.warn('❌ VB-Audio Cable is NOT installed.');
    }

    return found;
  }
  
  return false;
}

async function installAudioDriver() {
  const platform = os.platform();
  let installerDir;

  if (isDev) {
    // in dev, get the absolute path to your local /installers
    installerDir = path.join(__dirname, "../installers");
  } else {
    // in production, this will be inside app.asar or unpacked `extraResources`
    installerDir = path.join(process.resourcesPath, "installers");
  }

  if (platform === "darwin") {
    const pkgPath = path.join(installerDir, "BlackHole2ch.pkg");

    if (!fs.existsSync(pkgPath)) {
      console.error("❌ .pkg not found at:", pkgPath);
      return;
    }

    console.log("Running installer from:", pkgPath);

    const command = `installer -pkg "${pkgPath}" -target /`;
    

    sudo.exec(command, { name: "Sinzo Client Installer" }, (error, stdout, stderr) => {
      if (error) {
        console.error("❌ BlackHole install failed:", error);
      } else {
        console.log("✅ BlackHole installed successfully.");
        
        dialog.showMessageBox({
          type: 'info',
          buttons: ['Restart Now'],
          defaultId: 0,
          title: 'Restart Required',
          message: 'BlackHole was installed successfully, but your Mac needs to restart to complete the installation.',
          detail: 'Please save your work before restarting.',
        }).then((result) => {
          if (result.response === 0) {
            const options = {
              name: 'Sinzo Client',
            };

            sudo.exec('shutdown -r now', options, (error, stdout, stderr) => {
              if (error) {
                console.error('⚠️ Failed to reboot:', error);
                return;
              }
            });
          }
        });
      }
      console.log("stdout:", stdout);
      console.log("stderr:", stderr);
    });
  }

  else if (platform === "win32") {
    const exePath = path.join(installerDir, "VBCABLE_Driver_Pack", "VBCABLE_Setup_x64.exe");
    if (!fs.existsSync(exePath)) {
      console.error("❌ VBCable installer not found at:", exePath);
      return;
    }

    const command = `"${exePath}" /S`; // Silent install

    sudo.exec(command, { name: 'VB Audio Cable Installer' }, (error, stdout, stderr) => {
      if (error) {
        console.error('VB-Cable install failed:', error);
        return;
      }
      console.log('VB-Cable installed successfully.');

      dialog.showMessageBox({
        type: 'info',
        buttons: ['Restart Now'],
        defaultId: 0,
        title: 'Restart Required',
        message: 'BlackHole was installed successfully, but your Mac needs to restart to complete the installation.',
        detail: 'Please save your work before restarting.',
      }).then((result) => {
        if (result.response === 0) {
          exec('sudo shutdown -r now', (err) => {
            if (err) console.error('⚠️ Failed to reboot:', err);
          });
        }
      });
    });
  }
}

function audioDeviceExists(deviceName) {
  try {
    const platform = os.platform();
    if (platform === "darwin") {
      const output = execSync("system_profiler SPAudioDataType", { encoding: "utf8" });
      return output.includes(deviceName);
    } else if (platform === "win32") {
      const output = execSync("powershell -Command \"Get-PnpDevice | Where-Object {$_.FriendlyName -like '*" + deviceName + "*'}\"", { encoding: "utf8" });
      return output.includes(deviceName);
    }
  } catch (err) {
    console.error("Failed to check audio devices:", err);
    return false;
  }
}

function setUpSinzoAudioDriver() {
  const hasAggregate = audioDeviceExists("Sinzo Aggregate Device");
  const hasMultiOut = audioDeviceExists("Sinzo Multi-Output");

  if (hasAggregate && hasMultiOut) {
    console.log("✅ Sinzo audio devices already exist. Skipping setup.");
    return;
  }

  let binaryPath;

  if (isDev) {
    binaryPath = path.join(__dirname, "../installers/sinzo_audio_helper");
    console.log("isDev111");
  } else {
    // Don't point inside app.asar! Use extraResources path
    binaryPath = path.resolve(process.resourcesPath, 'installers', 'sinzo_audio_helper');
    console.log("not Dev111");
  }
  console.log("Setting up Sinzo audio driver from:", binaryPath, isDev);

  sudo.exec(`"${binaryPath}"`, {
    name: "Sinzo Audio Helper",
    cwd: path.dirname(binaryPath),
  }, (error, stdout, stderr) => {
    if (error) {
      console.error(`Error creating aggregate device: ${error.message}`);
      return;
    }
    if (stderr) {
      console.error(`stderr: ${stderr}`);
    }
    console.log(`stdout: ${stdout}`);
  });

}

module.exports = { installAudioDriver, isDriverInstalled, setUpSinzoAudioDriver };
