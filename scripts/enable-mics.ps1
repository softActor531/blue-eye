$micDevices = Get-PnpDevice -Class "AudioEndpoint" | Where-Object { $_.FriendlyName -like "*microphone*" -and $_.Status -eq "Disabled" }

foreach ($device in $micDevices) {
    Write-Output "Enabling: $($device.FriendlyName) [$($device.InstanceId)]"
    pnputil /enable-device "$($device.InstanceId)"
}
