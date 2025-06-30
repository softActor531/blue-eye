// document.getElementById('saveBtn').addEventListener('click', () => {
//   const ip = document.getElementById('ipInput').value.trim();
//   if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
//     window.api.setUploadUrl(ip);
//     window.api.hideWindow();
//   } else {
//     alert('Enter a valid IP address');
//   }
// });

window.electronAPI?.onVersionMismatch?.((event, data) => {
  const messageEl = document.getElementById('version-warning');
  if (messageEl) {
    messageEl.innerText = `New version available.\nCurrent: ${data.local}, Latest: ${data.remote}`;
    messageEl.style.display = 'block';

    const link = document.getElementById('download-link');
    link.href = `http://${data.serverIP}:80`;
  }  
});

