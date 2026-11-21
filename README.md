# BTC · Análogos

Site privado que roda 24h num servidor. A cada hora fechada ele:

1. monta o "retrato" do momento do BTCUSDT (Binance Futuros): calendário (mês, dia da semana, hora) com prioridade, formato do movimento, volatilidade, volume e anúncios macro dos EUA;
2. busca os 50 momentos mais parecidos desde 2019 e vê o que aconteceu depois (1 h e 4 h);
3. gera uma sugestão quando ≥ 60% dos casos apontam o mesmo lado e o movimento esperado supera 1,5× o custo;
4. o juiz acompanha cada sugestão minuto a minuto e fecha no stop, no alvo ou no prazo, descontando taxa (0,05% por lado) e funding real.

Também grava open interest e funding a cada hora para análises futuras.

**Simulação sem dinheiro real. Não é recomendação de investimento.**

## Instalação na Oracle Cloud (gratuito)

### 1. Criar a conta
- Acesse cloud.oracle.com → "Sign up". Na **Home Region**, escolha **Brazil East (São Paulo)** (não dá para trocar depois).
- O cartão é pedido só para verificação; o plano "Always Free" não cobra.

### 2. Criar a máquina
- Menu → **Compute → Instances → Create instance**.
- **Image**: Canonical **Ubuntu 22.04** (ou 24.04).
- **Shape**: *Ampere* `VM.Standard.A1.Flex` com 1 OCPU e 6 GB (Always Free). Se aparecer "out of capacity", use *AMD* `VM.Standard.E2.1.Micro` (também Always Free).
- **Networking**: deixe "Assign a public IPv4 address" marcado.
- **SSH keys**: "Generate a key pair for me" → **Save private key** (guarde o arquivo).
- Create. Anote o **Public IP address**.

### 3. Liberar as portas 80 e 443
- Na página da instância → clique na **Subnet** → **Security Lists** → *Default Security List* → **Add Ingress Rules**:
  - Source CIDR `0.0.0.0/0`, IP Protocol TCP, Destination Port Range `80,443` → Add.

### 4. Instalar (um comando)
No Windows, abra o **PowerShell** na pasta onde salvou a chave e conecte:
```
ssh -i .\ssh-key-XXXX.key ubuntu@SEU_IP
```
(Se reclamar de permissão da chave, use o **Cloud Shell** da Oracle: ícone `>_` no topo do console, faça upload da chave e rode o mesmo comando.)

Já dentro do servidor, cole:
```
curl -fsSL https://raw.githubusercontent.com/romesbr/btc-analogos/main/install.sh | sudo bash
```
Ele pede a senha do site e, no fim, mostra o endereço: `https://SEU-IP-COM-TRACOS.sslip.io`.

### Comandos úteis
- Ver o que o servidor está fazendo: `sudo journalctl -u btc-analogos -f`
- Atualizar para a versão mais nova: rodar o comando de instalação de novo
- Trocar a senha: `sudo nano /opt/btc-analogos/.env` e depois `sudo systemctl restart btc-analogos`

## Arquivos
- `server.js` — coleta, motor, juiz e site (Node 20+, sem dependências)
- `core.js` — retrato do momento, busca de análogos, regra de sugestão e juiz
- `public/index.html` — o site
- `eventos.json` — agenda de CPI, Payroll e FOMC (atualizar quando sair o calendário de 2028)
- `dados/` — criado no servidor: histórico, sugestões, avaliações, funding, open interest
