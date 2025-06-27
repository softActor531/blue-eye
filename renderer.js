document.getElementById('saveBtn').addEventListener('click', () => {
  const ip = document.getElementById('ipInput').value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    window.api.setUploadUrl(ip);
    window.api.hideWindow();
  } else {
    alert('Enter a valid IP address');
  }
});
