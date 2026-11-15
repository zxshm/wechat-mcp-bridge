param(
    [string]$Endpoint = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$storage = Join-Path $env:LOCALAPPDATA 'CodexSpeech'
[IO.Directory]::CreateDirectory($storage) | Out-Null
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
$security = [Security.AccessControl.DirectorySecurity]::new()
$security.SetOwner($identity)
$security.SetAccessRuleProtection($true, $false)
$inheritance = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
$propagation = [Security.AccessControl.PropagationFlags]::None
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($identity, 'FullControl', $inheritance, $propagation, 'Allow'))
$security.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-5-18'), 'FullControl', $inheritance, $propagation, 'Allow'))
Set-Acl -LiteralPath $storage -AclObject $security

$form = [Windows.Forms.Form]::new()
$form.Text = '阿里云配音 API - 本机加密保存'
$form.Size = [Drawing.Size]::new(680, 400)
$form.StartPosition = 'CenterScreen'
$form.Font = [Drawing.Font]::new('Microsoft YaHei UI', 10)
$form.TopMost = $true
$label = [Windows.Forms.Label]::new()
$label.Text = "粘贴阿里云百炼 API Key，保存后可在本机重复使用。`r`n使用 Windows 当前账户加密，程序在配音时自动读取。"
$label.Location = [Drawing.Point]::new(24, 22)
$label.Size = [Drawing.Size]::new(610, 56)
$form.Controls.Add($label)
$keyBox = [Windows.Forms.TextBox]::new()
$keyBox.UseSystemPasswordChar = $true
$keyBox.Location = [Drawing.Point]::new(24, 92)
$keyBox.Size = [Drawing.Size]::new(610, 30)
$form.Controls.Add($keyBox)
$endpointLabel = [Windows.Forms.Label]::new()
$endpointLabel.Text = '语音 API 地址（已按当前百炼业务空间预填）'
$endpointLabel.Location = [Drawing.Point]::new(24, 144)
$endpointLabel.Size = [Drawing.Size]::new(610, 28)
$form.Controls.Add($endpointLabel)
$endpointBox = [Windows.Forms.TextBox]::new()
$endpointBox.Text = $Endpoint
$endpointBox.Location = [Drawing.Point]::new(24, 178)
$endpointBox.Size = [Drawing.Size]::new(610, 30)
$form.Controls.Add($endpointBox)
$status = [Windows.Forms.Label]::new()
$status.Location = [Drawing.Point]::new(24, 230)
$status.Size = [Drawing.Size]::new(610, 42)
$status.Text = '固定音色：龙安灵希，普通话，自然 1 倍语速。'
$form.Controls.Add($status)
$save = [Windows.Forms.Button]::new()
$save.Text = '加密保存，供本机后续配音使用'
$save.Location = [Drawing.Point]::new(24, 284)
$save.Size = [Drawing.Size]::new(610, 42)
$save.Add_Click({
    try {
        $value = $keyBox.Text.Trim()
        if ($value.Length -lt 20 -or $value.Length -gt 1024 -or $value -notmatch '^sk-[A-Za-z0-9._-]+$') {
            $status.Text = '请粘贴完整的百炼 API Key。'
            return
        }
        $uri = [Uri]::new($endpointBox.Text.Trim())
        if ($uri.Scheme -ne 'https' -or $uri.UserInfo -or ($uri.Host -ne 'dashscope.aliyuncs.com' -and $uri.Host -notmatch '^[a-z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com$')) {
            $status.Text = '请使用北京地域阿里云官方 HTTPS 语音 API 地址。'
            return
        }
        $secure = ConvertTo-SecureString -String $value -AsPlainText -Force
        $encrypted = ConvertFrom-SecureString -SecureString $secure
        [IO.File]::WriteAllText((Join-Path $storage 'aliyun-tts-key.dpapi'), $encrypted, [Text.UTF8Encoding]::new($false))
        $configuration = @{endpoint=$uri.AbsoluteUri; model='qwen-audio-3.1-tts-flash'; voice='longanlingxi_v3.1'; rate=1; savedAt=[DateTime]::UtcNow.ToString('o')}
        [IO.File]::WriteAllText((Join-Path $storage 'aliyun-tts.json'), ($configuration | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        $keyBox.Clear()
        $value = $null
        $encrypted = $null
        $secure.Dispose()
        $status.Text = '已加密保存。后续配音会自动读取，可以关闭窗口。'
        $status.ForeColor = [Drawing.Color]::DarkGreen
        $save.Enabled = $false
    } catch {
        $status.Text = '保存失败，请检查密钥格式和本机目录权限。'
    }
})
$form.Controls.Add($save)
$form.AcceptButton = $save
$form.Add_Shown({$form.Activate(); $keyBox.Focus()})
[Windows.Forms.Application]::Run($form)
