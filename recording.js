const { spawnSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const si = require('systeminformation');
const FormData = require('form-data');
const { app } = require('electron');

const isDev = !app.isPackaged;
let currentRecordingPath = '';
let recordingStartTime = null;
const platform = os.platform();
let serverUrl = '', macAddress = '';


function getFFmpegPath() {
  let ffmpegPath = '';
  if (isDev) {
    ffmpegPath = path.join(__dirname, './assets', 'ffmpeg');
  } else {
    ffmpegPath = path.join(process.resourcesPath, 'assets', 'ffmpeg');
  }
  return platform === 'win32'
    ? path.join(ffmpegPath, 'ffmpeg.exe')
    : path.join(ffmpegPath, 'ffmpeg');
}

function getTimeStamp(timeOffset = 9) {
  const now = new Date();
  const utc8 = new Date(now.getTime() + timeOffset * 60 * 60 * 1000); // add 8 hours
  return utc8.toISOString().replace(/[-:.TZ]/g, "");
}

function getOutputPath() {
  const extension = platform === 'win32' ? '.wav' : '.mov';
  const fileName = `${getTimeStamp()}.${extension}`; // Save as audio-only
  currentRecordingPath = path.join(os.tmpdir(), fileName);
  return currentRecordingPath;
}

function listAudioDevices() {
  const ffmpegPath = getFFmpegPath();
  const result = spawnSync(ffmpegPath, ['-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], {
    encoding: 'utf8',
    shell: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const output = result.stderr || result.stdout;
  const lines = output.split('\n');

  const audioDevices = lines
    .map(line => {
      const match = line.match(/"(.+?)"\s+\(audio\)/);
      return match ? match[1] : null;
    })
    .filter(Boolean);

  return audioDevices;
}

function getDefaultMic(devices) {
  // Assume first device is default mic (not VB-Cable)
  return devices.find(d => !d.toLowerCase().includes('vb-audio')) || devices[0];
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
    const devices = listAudioDevices();
    const mic = getDefaultMic(devices);
    const vb = devices.find(d => d.toLowerCase().includes('vb-audio'));

    if (!mic || !vb) {
      console.error('❌ Could not find both mic and VB-Audio Virtual Cable devices.');
      console.log('Found devices:', devices);
      return;
    }

    console.log(`Mic device: ${mic}`);
    console.log(`VB-Cable devic21312312e: ${vb}`);

    const args = [
      // Microphone input
      '-f', 'dshow',
      '-i', `audio=${mic}`,

      // System output input (VB-Cable)
      '-f', 'dshow',
      '-i', `audio=${vb}`,

      // Merge both audio streams
      '-filter_complex', '[0:a][1:a]amerge=inputs=2[aout]',
      '-map', '[aout]',

      // Encoding settings
      '-acodec', 'pcm_s16le',
      '-ar', '44100',
      '-ac', '2',
      '-y',
      output
    ];
    console.log(ffmpeg, args);
    recordingStartTime = Date.now();
    ffmpegProcess = spawn(ffmpeg, args);
    ffmpegProcess.stderr.on('data', (data) => {
      // console.log(`[FFmpeg]: ${data.toString()}`);
    });

    ffmpegProcess.on('exit', async (code) => {
      console.log(`[FfmpegProcess exited]: ${code}`);
      const durationSeconds = ((Date.now() - recordingStartTime) / 1000).toFixed(2);
      recordingStartTime = null;
      if (serverUrl) {
        await uploadRecording(serverUrl, durationSeconds, macAddress);
      }
    });

    
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
  console.log("stop recording ", ffmpegProcess);
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

    console.log(`Audio uploaded (${durationSeconds}s)`);
    // fs.unlinkSync(currentRecordingPath);
    currentRecordingPath = '';
  } catch (err) {
    console.error('❌ Upload failed:', err.message);
  }
}


module.exports = { startRecording, stopRecording };
