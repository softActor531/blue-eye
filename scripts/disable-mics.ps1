# disable-mics.ps1
$micDevices = Get-PnpDevice -Class "AudioEndpoint" | Where-Object { $_.FriendlyName -like "*microphone*" -and $_.Status -eq "OK" }

foreach ($device in $micDevices) {
    Write-Output "Disabling: $($device.FriendlyName) [$($device.InstanceId)]"
    pnputil /disable-device "$($device.InstanceId)"
}
