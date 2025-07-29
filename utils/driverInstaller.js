const path = require("path");
const os = require("os");
const fs = require("fs");
const sudo = require("sudo-prompt");
const { app } = require('electron');
const isDev = !app.isPackaged;
const { dialog } = require('electron');
const { execSync } = require("child_process");

function isDriverInstalled() {
  return fs.existsSync("/Library/Audio/Plug-Ins/HAL/BlackHole2ch.driver");
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
            const { exec } = require('child_process');
            exec('sudo shutdown -r now', (err) => {
              if (err) console.error('⚠️ Failed to reboot:', err);
            });
          }
        });
      }
      console.log("stdout:", stdout);
      console.log("stderr:", stderr);
    });
  }

  else if (platform === "win32") {
    const exePath = path.join(installerDir, "VBCABLE_Setup.exe");
    const child = require("child_process").spawn(exePath, ["/S"], {
      detached: true,
      stdio: "ignore"
    });
    child.on("error", err => console.error("VB-Cable install error:", err));
    child.unref();
  }
}

function audioDeviceExists(deviceName) {
  try {
    const output = execSync("system_profiler SPAudioDataType", { encoding: "utf8" });
    return output.includes(deviceName);
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
