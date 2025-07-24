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
  }
  const link = document.getElementById('download-link');
  if (link) {
    link.href = `http://${data.serverIP}:80`;
    link.style.display = 'block';
  }
});

window.electronAPI.onRouterList((routers) => {
  const container = document.getElementById('routers');
  container.innerHTML = `
    <h4>Select a Router</h4>
    <table border="1" cellpadding="6" cellspacing="0" style="width:100%; border-collapse: collapse;">
      <thead>
        <tr style="background-color: #f0f0f0;">
          <th style="text-align: left;">Router Name</th>
          <th style="text-align: left;">Router Address</th>
          <th style="text-align: left;">Ping 1</th>
          <th style="text-align: left;">Ping 2</th>
          <th style="text-align: left;">Action</th>
        </tr>
      </thead>
      <tbody id="router-body"></tbody>
    </table>
  `;

  const tbody = document.getElementById('router-body');
  routers.forEach(router => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${router.name}</td>
      <td>${router.router_address}</td>
      <td>${router.ping1?.time || ''}</td>
      <td>${router.ping2?.time || ''}</td>
      <td><button onclick="window.electronAPI.selectRouter('${router.router_address}')">Select</button></td>
    `;
    tbody.appendChild(row);
  });
});

window.electronAPI?.getDeviceId?.().then((currentId) => {
  const input = document.getElementById('deviceIdInput');
  if (input && currentId) {
    input.value = currentId;
  }
});

document.getElementById('saveDeviceIdBtn')?.addEventListener('click', () => {
  const input = document.getElementById('deviceIdInput');
  const id = input?.value.trim();

  if (id.length === 0) {
    alert('Device ID cannot be empty');
    return;
  }

  window.electronAPI?.setDeviceId?.(id);
  alert('Device ID saved!');
  window.electronAPI?.hideWindow?.();
});