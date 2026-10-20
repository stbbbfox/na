#!/bin/bash
# ============================================================
# 代理服务部署脚本（最后成功的那次：VMess+WS 穿过 Argo Tunnel）
# 适用：Argo ingress 锁 http://localhost:3000
# 可重复执行（幂等），已装好的步骤会跳过
# ============================================================
set -e

export PATH="$PATH:/app/user-packages/node/bin"   # 确保能调到 pm2（装在 /app/user-packages/node/bin）

# ---------- 配置区（按需修改）----------
DOMAIN="dc.stbbbfox.kdns.fr"                     # Argo 子域名
UUID="2b7a9f4c-69c6-4fa5-870c-d7285f291589"       # VMess 客户端 ID
WS_PATH="/vmess-argo"                              # WebSocket 路径
PORT="3000"                                        # 本机监听端口（必须与 Argo ingress 对齐）
ARGO_TOKEN="eyJhIjoiNTYwYTJhOGViZDgzM2VmNTcwOGU5MWRkMmQwNzNlOGIiLCJ0IjoiNzVkMzc5NWEtNmYzZS00NDdhLThhZjItMmJkMWVmNGRkMjczIiwicyI6Ill6WmlZalV4TTJZdE0yTTJNQzAwWmpFNUxUZzFPRE10TW1FMll6QmlNR1ExWXprMyJ9"
# --------------------------------------

echo "=== 步骤 1：确认 Xray 内核已安装 ==="
if [ ! -f /usr/local/bin/xray ]; then
    echo "下载 Xray 二进制..."
    cd /tmp
    curl -sL -o xray.zip "https://github.com/XTLS/Xray-core/releases/latest/download/Xray-linux-64.zip"
    python3 -c "import zipfile; zipfile.ZipFile('xray.zip').extractall('/usr/local/bin/')"
    chmod +x /usr/local/bin/xray*
    echo "Xray 安装完成"
else
    echo "Xray 已存在：$(/usr/local/bin/xray version 2>&1 | head -1)"
fi

echo "=== 步骤 2：写 V2Ray/Xray 配置（VMess+WS 监听 $PORT）==="
mkdir -p /usr/local/etc/v2ray /var/log/v2ray
cat > /usr/local/etc/v2ray/config.json <<EOF
{
  "log": { "access": "/var/log/v2ray/access.log", "error": "/var/log/v2ray/error.log", "loglevel": "info" },
  "inbounds": [
    {
      "listen": "0.0.0.0",
      "port": $PORT,
      "protocol": "vmess",
      "settings": {
        "clients": [
          { "id": "$UUID", "level": 0 }
        ]
      },
      "streamSettings": {
        "network": "ws",
        "wsSettings": { "path": "$WS_PATH" }
      }
    }
  ],
  "outbounds": [
    { "protocol": "freedom", "settings": {} }
  ]
}
EOF
echo "配置已写入 /usr/local/etc/v2ray/config.json"

echo "=== 步骤 3：写 xray PM2 启动脚本 ==="
mkdir -p /opt/myapp
cat > /opt/myapp/run_xray.sh <<'EOF'
#!/bin/bash
# 清除代理环境变量，避免 xray 出站走错代理
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy all_proxy ALL_PROXY
# 前台运行 xray（PM2 负责托管和自动重启）
exec /usr/local/bin/xray run -config /usr/local/etc/v2ray/config.json
EOF
chmod +x /opt/myapp/run_xray.sh
echo "xray 启动脚本已写入"

echo "=== 步骤 4：写 Argo Tunnel PM2 启动脚本 ==="
cat > /opt/myapp/run_cfargo.sh <<EOF
#!/bin/bash
# 环境变量写死在脚本内，PM2 重启不丢失
export ARGO_AUTH="$ARGO_TOKEN"
export ARGO_DOMAIN="$DOMAIN"
export ARGO_PORT="$PORT"
# 清除代理环境变量，避免 cloudflared 走错代理
unset HTTP_PROXY HTTPS_PROXY http_proxy https_proxy all_proxy ALL_PROXY
# 前台运行 cloudflared（PM2 托管，tunnel 断开自动重连）
exec /usr/local/bin/cloudflared tunnel --edge-ip-version auto --no-autoupdate --protocol http2 run --token "\$ARGO_AUTH"
EOF
chmod +x /opt/myapp/run_cfargo.sh
echo "cloudflared 启动脚本已写入"

echo "=== 步骤 5：PM2 托管两个进程 ==="
# 先删掉旧的同名进程（避免端口占用/重复）
pm2 stop xray 2>/dev/null || true
pm2 delete xray 2>/dev/null || true
pm2 stop cfargo 2>/dev/null || true
pm2 delete cfargo 2>/dev/null || true
# 启动 xray（VMess 内核）
pm2 start /opt/myapp/run_xray.sh --name xray --interpreter /bin/bash
# 启动 cloudflared（Argo Tunnel）
pm2 start /opt/myapp/run_cfargo.sh --name cfargo --interpreter /bin/bash
sleep 6   # 等 tunnel 注册到 Cloudflare 边缘
echo "PM2 进程状态："
pm2 list | grep -E "xray|cfargo"

echo "=== 步骤 6：PM2 持久化（重启自动拉起）==="
pm2 save

echo "=== 步骤 7：验证 ==="
echo "--- 本地 $PORT 连通 ---"
python3 -c "
import socket
s=socket.socket(); s.settimeout(3)
try: s.connect(('127.0.0.1',$PORT)); print('本地 $PORT 有服务 ✅')
except: print('本地 $PORT 没服务 ❌')
s.close()
"
echo "--- 外网 Argo 验证（应返回 400 而非 502）---"
curl -s -o /dev/null -w "外网 $DOMAIN/vmess-argo = %{http_code}\n" -m 15 --noproxy '*' "https://$DOMAIN$WS_PATH"
echo "  说明：400 = WS 握手到达 xray（正常）；502 = 未通"

echo
echo "=== 客户端节点链接（复制导入 V2Ray 客户端）==="
python3 -c "
import json, base64
cfg = {
    'v':'2','ps':'Ag2-Vmess','add':'$DOMAIN','port':'443',
    'id':'$UUID','aid':'0','scy':'none',
    'net':'ws','type':'none','host':'$DOMAIN','path':'$WS_PATH',
    'tls':'tls','sni':'$DOMAIN','alpn':'','fp':'chrome'
}
print('vmess://' + base64.b64encode(json.dumps(cfg).encode()).decode())
"
echo
echo "=== 部署完成 ==="
