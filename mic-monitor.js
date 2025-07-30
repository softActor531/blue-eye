const { spawn } = require("child_process");
const os = require("os");
const path = require("path");
const psList = require("ps-list");
const readline = require("readline");

const ffmpegPath = os.platform() === "win32"
  ? path.join(__dirname, "assets", "ffmpeg", "ffmpeg.exe")
  : path.join(__dirname, "assets", "ffmpeg", "ffmpeg");

let ffmpegProcess = null;
let isRecording = false;
let silenceCounter = 0;

function getFFmpegArgs() {
  if (os.platform() === "darwin") {
    return [
      "-hide_banner",
      "-f", "avfoundation",
      "-i", ":0",
      "-af", "astats=metadata=1:reset=1",
      "-f", "null", "-"
    ];
  } else {
    return [
      "-hide_banner",
      "-f", "dshow",
      "-i", "audio=Microphone", // Change to match your device
      "-af", "astats=metadata=1:reset=1",
      "-f", "null", "-"
    ];
  }
}

async function isCommunityAppRunning() {
  const list = await psList();
  const targets = ["zoom", "chrome", "firefox", "slack", "teams", "discord"];
  return list.some(proc =>
    targets.some(name => proc.name.toLowerCase().includes(name))
  );
}

function startFFmpegMonitor() {
  if (ffmpegProcess) return;

  ffmpegProcess = spawn(ffmpegPath, getFFmpegArgs());

  const rl = readline.createInterface({
    input: ffmpegProcess.stderr,
    crlfDelay: Infinity,
  });

  rl.on("line", async (line) => {
    // Example line: [Parsed_astats_0 @ 0x...] Channel: 0 RMS level dB: -43.7
    const match = line.match(/RMS level dB:\s*(-?\d+(\.\d+)?)/);
    if (match) {
      const volume = parseFloat(match[1]);
      const isAppRunning = await isCommunityAppRunning();

      if (volume > -50 && isAppRunning) {
        if (!isRecording) {
          console.log("🎙️ Mic in use! Volume:", volume);
          isRecording = true;
        }
        silenceCounter = 0;
      } else {
        silenceCounter++;
        if (silenceCounter > 5 && isRecording) {
          console.log("⏹️ Mic silence or app closed.");
          isRecording = false;
        }
      }
    }
  });

  ffmpegProcess.on("close", () => {
    console.log("FFmpeg process exited");
    ffmpegProcess = null;
  });
}

module.exports = {
  startFFmpegMonitor,
};