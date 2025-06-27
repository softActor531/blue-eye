const { spawn } = require('child_process');
const path = require('path');

function launchApp() {
    const appPath = path.join(__dirname, 'app.js');

    const child = spawn(process.execPath, [appPath], {
        stdio: 'ignore',
        detached: true
    });

    child.unref();

    child.on('exit', (code) => {
        setTimeout(launchApp, 20000); // restart in 10s
    });
}

launchApp();
