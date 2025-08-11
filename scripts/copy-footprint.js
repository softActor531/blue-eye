// scripts/copy-footprint.js
const fs = require('fs');
const path = require('path');

const footprintPath = path.join(__dirname, '../installers/footprint.node');

if (process.platform === 'darwin') {
  console.log('✅ macOS detected — keeping footprint.node');
} else {
  if (fs.existsSync(footprintPath)) {
    fs.unlinkSync(footprintPath);
    console.log('🗑️ Windows/Linux detected — footprint.node removed');
  }
}
