const { spawnSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const si = require('systeminformation');
const FormData = require('form-data');
let currentRecordingPath = '';
let recordingStartTime = null, micProcess, systemProcess;
const micOutput = path.join(__dirname, 'mic.wav');
const systemOutput = path.join(__dirname, 'system.wav');
let serverUrl = '', macAddress = '';


function getFFmpegPath() {
  return os.platform() === 'win32'
    ? path.join(__dirname, 'assets', 'ffmpeg', 'ffmpeg.exe')
    : path.join(__dirname, 'assets', 'ffmpeg', 'ffmpeg');
}

function getTimeStamp(timeOffset = 9) {
  const now = new Date();
  const utc8 = new Date(now.getTime() + timeOffset * 60 * 60 * 1000); // add 8 hours
  return utc8.toISOString().replace(/[-:.TZ]/g, "");
}

function getOutputPath() {
  const fileName = `${getTimeStamp()}.mov`; // Save as audio-only
  currentRecordingPath = path.join(__dirname, fileName);
  return currentRecordingPath;
}

async function getDefaultInputDevice() {
  try {
    const audioDevices = await si.audio();
    // console.log("audio devices ", audioDevices);
    // Find the default input device
    const defaultInput = audioDevices.find(device => device.default === true && device.type === 'input');
    
    if (defaultInput) {
      return defaultInput.name;
    } else {
      if (audioDevices[0].type === 'Sound Driver') {
        return audioDevices[0].name;
      }
      throw new Error('No default input device found');
    }
  } catch (err) {
    console.error('Failed to get default input device:', err);
    return null;
  }
}

function getAudioDeviceIndexByName(deviceName) {
  const ffmpegPath = getFFmpegPath();

  let result;

  if (os.platform() === 'win32') {
    // For Windows, we use DirectShow
    result = spawnSync(ffmpegPath, [
        '-list_devices', 'true',
        '-f', 'dshow',
        '-i', 'dummy'
      ], { encoding: 'utf8', stdio: 'pipe' });
    } else {
      // For macOS, we use AVFoundation
      result = spawnSync(ffmpegPath, [
        '-f', 'avfoundation',
        '-list_devices', 'true',
        '-i', ''
      ], { encoding: 'utf8', stdio: 'pipe' });
    }

  const output = result.stderr.toString();
  const lines = output.split('\n');

  let audioSection = false;
  for (const line of lines) {
    if (line.includes('AVFoundation audio devices')) {
      audioSection = true;
      continue;
    }
    if (audioSection) {
      const match = line.match(/\[(\d+)\] (.+)/);
      if (match) {
        const index = match[1];
        const name = match[2].trim();
        if (name.includes(deviceName)) {
          return index;
        }
      } else if (line.includes('video devices')) {
        break;
      }
    }
  }

  return null;
}

let ffmpegProcess = null;

// function startMicMonitor() {
//   let installerDir;

//   if (isDev) {
//     installerDir = path.join(__dirname, './installers');
//   } else {
//     installerDir = path.join(process.resourcesPath, 'installers');
//   }

//   const micMonitorPath = path.join(installerDir, 'mic-monitor');

//   console.log(`Starting mic-monitor from: ${micMonitorPath}`);

//   // No stdbuf needed anymore
//   const micMonitor = spawn('sudo', [micMonitorPath], {
//     env: process.env,           // Pass current env
//     stdio: ['pipe', 'pipe', 'pipe'], // Enable stdout/stderr
//   });

//   let micInUse = false;
//   let micCheckInterval = null;

//   micMonitor.stdout.on('data', (data) => {
//     const msg = data.toString().trim();
//     console.log(`mic-monitor: ${msg}`);

//     if (msg === 'MIC_ON') {
//       if (!micInUse) {
//         micInUse = true;
//         startRecording();

//         micCheckInterval = setInterval(() => {
//           // Request mic-monitor status again or just wait for "MIC_OFF"
//           // If you stop getting MIC_ON updates for N seconds, stop
//         }, 1000);
//       }
//     } else if (msg === 'MIC_OFF') {
//       if (micInUse) {
//         micInUse = false;
//         clearInterval(micCheckInterval);
//         stopRecording();
//       }
//     }
//   });


//   micMonitor.stderr.on('data', (data) => {
//     console.error(`mic-monitor error: ${data.toString()}`);
//   });

//   micMonitor.on('close', (code) => {
//     console.log(`mic-monitor process exited with code ${code}`);
//   });
// }

async function startRecording() {
  const platform = os.platform();
  const ffmpeg = getFFmpegPath();
  const output = getOutputPath();

  let deviceIndex;

  if (platform === 'win32') {
    const defaultInputDevice = await getDefaultInputDevice();
    const vbAudioCableDevice = 'VB-Audio Virtual Cable';

    if (!defaultInputDevice) {
      console.error('❌ No default input device found');
      return;
    }

    // Record microphone
    micProcess = spawn(ffmpeg, [
      '-f', 'dshow',
      '-i', `audio=${defaultInputDevice}`,
      '-acodec', 'pcm_s16le',
      '-y', micOutput
    ]);

    // Record system audio (via VB-Cable)
    systemProcess = spawn(ffmpeg, [
      '-f', 'dshow',
      '-i', `audio=${vbAudioCableDevice}`,
      '-acodec', 'pcm_s16le',
      '-y', systemOutput
    ]);

    micProcess.stderr.on('data', () => {});
    systemProcess.stderr.on('data', () => {});

    micProcess.on('exit', code => console.log(`[Mic exited]: ${code}`));
    systemProcess.on('exit', code => console.log(`[System exited]: ${code}`));

    recordingStartTime = Date.now();
    console.log('🎙️ Recording started (mic + system audio)...');
  } else if (platform === 'darwin') {
    deviceIndex = getAudioDeviceIndexByName('Sinzo Aggregate Device');
    if (deviceIndex === null) {
      console.error('❌ Sinzo Aggregate Device not found in AVFoundation');
      return;
    }

    const args = [
      '-f', 'avfoundation',
      '-i', `none:${deviceIndex}`,
      '-ac', '2', // force stereo
      '-ar', '44100', // force sample rate
      '-c:a', 'aac',
      '-b:a', '192k',
      '-y',
      output
    ];

    recordingStartTime = Date.now();
    ffmpegProcess = spawn(ffmpeg, args);

    ffmpegProcess.stderr.on('data', (data) => {
      // console.log(`[FFmpeg]: ${data.toString()}`);
    });

    ffmpegProcess.on('exit', async (code) => {
      console.log(`[FFmpeg exited]: ${code}`);
      const durationSeconds = ((Date.now() - recordingStartTime) / 1000).toFixed(2);
      recordingStartTime = null;
      if (serverUrl) {
        await uploadRecording(serverUrl, durationSeconds, macAddress);
      }
    });
    console.log(`🎙️ Recording started → ${output}`);
  }
}

async function stopRecording(apiUrl, mac) {
  if (os.platform() === 'win32') {
    if (micProcess) micProcess.kill('SIGINT');
    if (systemProcess) systemProcess.kill('SIGINT');
    const durationSeconds = ((Date.now() - recordingStartTime) / 1000).toFixed(2);
    recordingStartTime = null;

    console.log('Recording stopped. Merging...');

    const ffmpeg = getFFmpegPath();

    const merge = spawnSync(ffmpeg, [
      '-i', micOutput,
      '-i', systemOutput,
      '-filter_complex', 'amix=inputs=2:duration=longest',
      '-y', getOutputPath()
    ]);

    if (merge.stderr.length) {
      console.log(merge.stderr.toString());
    }

    console.log('✅ Merged output saved at:', getOutputPath());

    setTimeout(async () => {
      await uploadRecording(apiUrl, durationSeconds, mac);
    }, 1000);

    // Optional: clean up
    try {
      fs.unlinkSync(micOutput);
      fs.unlinkSync(systemOutput);
    } catch (e) {
      console.warn('⚠️ Cleanup failed:', e.message);
    }
  }
  if (ffmpegProcess) {
    serverUrl = apiUrl;
    macAddress = mac;
    ffmpegProcess.kill('SIGINT');
    ffmpegProcess = null;
  }
}

async function uploadRecording(serverUrl, durationSeconds, macAddress) {
  if (!currentRecordingPath) {
    console.warn('No recording file found to upload.');
    return;
  }

  try {
    const fileData = fs.createReadStream(currentRecordingPath);
    const { size } = fs.statSync(currentRecordingPath);

    const form = new FormData();
    form.append('file', fileData, {
      filename: path.basename(currentRecordingPath),
      contentType: 'audio/mov',
    });

    const headers = {
      ...form.getHeaders(),
      'X-Audio-Duration': durationSeconds.toString(),
      'X-Mac-Address': macAddress
    };
    await axios.post(serverUrl, form, { headers});

    console.log(`✅ Audio uploaded (${durationSeconds}s)`);
    fs.unlinkSync(currentRecordingPath);
    currentRecordingPath = '';
  } catch (err) {
    console.error('❌ Upload failed:', err.message);
  }
}


module.exports = { startRecording, stopRecording };
