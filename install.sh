#!/usr/bin/env bash
# Instalador do BTC · Análogos para Ubuntu (Vultr, Oracle Cloud ou qualquer VPS).
# Uso: curl -fsSL https://raw.githubusercontent.com/romesbr/btc-analogos/main/install.sh | sudo bash
set -euo pipefail
REPO="${REPO:-https://github.com/romesbr/btc-analogos.git}"
DIR=/opt/btc-analogos
[ "$(id -u)" = 0 ] || { echo "Rode com sudo."; exit 1; }

echo "==> Pacotes básicos"
export DEBIAN_FRONTEND=noninteractive
echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
apt-get update -y
apt-get install -y curl git ca-certificates gnupg debian-keyring debian-archive-keyring apt-transport-https iptables-persistent

echo "==> Node.js 22"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "==> Caddy (HTTPS automático)"
if ! command -v caddy >/dev/null; then
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -y && apt-get install -y caddy
fi

echo "==> Código"
id btc >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin btc
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull --ff-only; else git clone "$REPO" "$DIR"; fi
mkdir -p "$DIR/dados"

if [ ! -f "$DIR/.env" ]; then
  PASS="${PANEL_PASSWORD:-}"
  while [ -z "$PASS" ]; do read -rsp "Defina a senha do site: " PASS < /dev/tty; echo; done
  cat > "$DIR/.env" <<EOF
PANEL_PASSWORD=$PASS
PORT=8080
HOST=127.0.0.1
DATA_DIR=$DIR/dados
EOF
  chmod 600 "$DIR/.env"
fi
chown -R btc:btc "$DIR"

echo "==> Serviço (reinicia sozinho e sobe junto com a máquina)"
cat > /etc/systemd/system/btc-analogos.service <<EOF
[Unit]
Description=BTC Analogos
After=network-online.target
Wants=network-online.target
[Service]
User=btc
WorkingDirectory=$DIR
ExecStart=/usr/bin/node $DIR/server.js
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now btc-analogos
systemctl restart btc-analogos

echo "==> Endereço HTTPS"
IP="$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)"
DOMAIN="${IP//./-}.sslip.io"
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
  reverse_proxy 127.0.0.1:8080
}
EOF

echo "==> Firewall da máquina (portas 80 e 443)"
for P in 80 443; do
  iptables -C INPUT -p tcp --dport $P -j ACCEPT 2>/dev/null || iptables -I INPUT 5 -p tcp --dport $P -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport $P -j ACCEPT
done
netfilter-persistent save || true
if command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then ufw allow 80/tcp; ufw allow 443/tcp; fi
systemctl restart caddy

echo
echo "======================================================="
echo " Pronto. Site: https://$DOMAIN"
echo " Usuário: qualquer nome · Senha: a que você definiu"
echo " (o certificado HTTPS pode levar 1-2 min na primeira vez;"
echo "  o histórico da Binance leva ~1 min para baixar)"
echo " Logs:   sudo journalctl -u btc-analogos -f"
echo " Atualizar: rode este mesmo comando de novo"
echo "======================================================="
