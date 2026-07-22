# 🚀 Setup Pi Agent + OpenCode Go

## Instalación Rápida

### Opción 1: Script automático (recomendado)

```bash
# Descargar y ejecutar el script
bash scripts/setup-pi-opencode-go.sh
```

### Opción 2: Instalación manual

```bash
# 1. Instalar Pi Agent globalmente
npm install -g @earendil-works/pi-coding-agent

# 2. Crear directorio de extensiones
mkdir -p ~/.pi/agent/extensions

# 3. Copiar la extension (ya está en ~/.pi/agent/extensions/opencode-go.ts)

# 4. Configurar API key
export OPENCODE_API_KEY='tu-api-key-aqui'
echo 'export OPENCODE_API_KEY="tu-api-key-aqui"' >> ~/.bashrc

# 5. Verificar modelos
pi --list-models
```

## 📋 Modelos Disponibles

| Modelo | Precio Input | Precio Output | Contexto | Reasoning |
|--------|-------------|---------------|----------|-----------|
| `mimo-v2.5` | $0.14 | $0.28 | 1M | ✅ |
| `deepseek-v4-flash` | $0.14 | $0.28 | 1M | ✅ |
| `deepseek-v4-pro` | $1.74 | $3.48 | 1M | ✅ |
| `kimi-k2.6` | $0.95 | $4.00 | 262K | ✅ |
| `kimi-k2.7-code` | $0.95 | $4.00 | 262K | ✅ |
| `qwen3.6-plus` | $0.50 | $3.00 | 1M | ✅ |
| `qwen3.7-plus` | $0.40 | $1.60 | 1M | ✅ |
| `qwen3.7-max` | $2.50 | $7.50 | 1M | ✅ |
| `glm-5.1` | $1.40 | $4.40 | 202K | ✅ |
| `glm-5.2` | $1.40 | $4.40 | 1M | ✅ |
| `minimax-m2.7` | $0.30 | $1.20 | 204K | ✅ |
| `minimax-m3` | $0.30 | $1.20 | 1M | ✅ |
| `mimo-v2.5-pro` | $1.74 | $3.48 | 1M | ✅ |

## 🔧 Configuración

### Variables de Entorno

```bash
# Requerido
export OPENCODE_API_KEY='tu-api-key-aqui'

# Opcional (para proxies)
export PROXY_HOST='...'
export PROXY_PORT='...'
export PROXY_USER='...'
export PROXY_PASS='...'
```

### Settings (auto-configurado)

El script crea automáticamente `~/.pi/agent/settings.json`:

```json
{
  "theme": "dark",
  "defaultProvider": "opencode-go",
  "defaultModel": "mimo-v2.5"
}
```

### Cambiar modelo por defecto

Edita `~/.pi/agent/settings.json`:

```json
{
  "defaultModel": "deepseek-v4-pro"
}
```

O usa `Ctrl+P` o `/model` dentro de pi para cambiar en runtime.

## 🚀 Uso

```bash
# En tu proyecto
cd /path/to/your/project
pi

# Seleccionar modelo
# - Ctrl+P: Cycling rápido
# - /model: Menú interactivo
# - /model mimo-v2.5: Selección directa

# Thinking levels (para modelos reasoning)
# - Ctrl+T: Cambiar nivel
# - Niveles: off, minimal, low, medium, high, xhigh
```

## 📁 Estructura de Archivos

```
~/.pi/
├── agent/
│   ├── extensions/
│   │   └── opencode-go.ts      ← Extension de OpenCode Go
│   ├── settings.json           ← Configuración por defecto
│   ├── auth.json               ← Tokens de autenticación
│   └── skills/                 ← Skills adicionales
```

## 🔄 Deploy en Múltiples VPS

Para deployar en tus VPS de Hetzner:

```bash
# 1. Subir el script a tu repo o servidor
scp scripts/setup-pi-opencode-go.sh user@vps-host:~/

# 2. Ejecutar en cada VPS
ssh user@vps-host
bash ~/setup-pi-opencode-go.sh

# 3. Configurar API key en cada VPS
echo 'export OPENCODE_API_KEY="tu-key"' >> ~/.bashrc
source ~/.bashrc
```

### Script SSH para todos los VPS

```bash
#!/bin/bash
# deploy-all-vps.sh

VPS_LIST=(
    "user@vps1.example.com"
    "user@vps2.example.com"
    "user@vps3.example.com"
)

for vps in "${VPS_LIST[@]}"; do
    echo "Deploying to $vps..."
    scp scripts/setup-pi-opencode-go.sh "$vps":~/
    ssh "$vps" "bash ~/setup-pi-opencode-go.sh && echo 'export OPENCODE_API_KEY=\"tu-key\"' >> ~/.bashrc"
done
```

## 🛠️ Troubleshooting

### "Provider not found"

```bash
# Recargar extensiones
/reload

# O reiniciar pi
exit
pi
```

### "API key not found"

```bash
# Verificar variable
echo $OPENCODE_API_KEY

# Recargar bash
source ~/.bashrc

# O configurar directamente
export OPENCODE_API_KEY='tu-key'
```

### "Model not available"

```bash
# Listar modelos disponibles
pi --list-models

# Verificar que el provider está registrado
# En pi: /status
```

## 📚 Enlaces

- [Pi Agent Docs](https://github.com/earendil-works/pi-coding-agent)
- [OpenCode Go](https://opencode.ai)
- [Custom Providers](https://github.com/earendil-works/pi-coding-agent/blob/main/docs/custom-provider.md)

## 🤝 Contribuir

Para agregar nuevos modelos, edita `~/.pi/agent/extensions/opencode-go.ts` y agrega el modelo al array `models`.
