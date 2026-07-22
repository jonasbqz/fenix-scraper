#!/bin/bash

# =============================================================================
# Script de Setup: Pi Agent + OpenCode Go Provider
# =============================================================================
# Ejecutar en cada VPS para configurar pi-agent con opencode-go
# Uso: curl -sL https://raw.githubusercontent.com/.../setup-pi-opencode-go.sh | bash
# O:   bash setup-pi-opencode-go.sh
# =============================================================================

set -e

# Colores
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log() { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
error() { echo -e "${RED}[✗]${NC} $1"; exit 1; }
info() { echo -e "${BLUE}[i]${NC} $1"; }

# =============================================================================
# 1. Verificar prerrequisitos
# =============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  🚀 Setup Pi Agent + OpenCode Go"
echo "═══════════════════════════════════════════════════════════════════"
echo ""

# Verificar Node.js
if ! command -v node &> /dev/null; then
    warn "Node.js no encontrado. Instalando..."
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi
log "Node.js $(node --version) detectado"

# Verificar npm
if ! command -v npm &> /dev/null; then
    error "npm no encontrado"
fi
log "npm $(npm --version) detectado"

# =============================================================================
# 2. Instalar Pi Agent Globalmente
# =============================================================================
echo ""
info "Instalando @earendil-works/pi-coding-agent globalmente..."

if npm list -g @earendil-works/pi-coding-agent &> /dev/null 2>&1; then
    log "Pi Agent ya instalado. Actualizando..."
    npm update -g @earendil-works/pi-coding-agent
else
    npm install -g @earendil-works/pi-coding-agent
fi

log "Pi Agent instalado"

# =============================================================================
# 3. Crear Estructura de Configuración
# =============================================================================
echo ""
info "Creando estructura de configuración..."

# Crear directorios
mkdir -p ~/.pi/agent/extensions
mkdir -p ~/.pi/agent/skills
mkdir -p ~/.pi/agent/prompts

log "Directorios creados"

# =============================================================================
# 4. Configurar OpenCode Go Extension
# =============================================================================
echo ""
info "Configurando OpenCode Go provider..."

cat > ~/.pi/agent/extensions/opencode-go.ts << 'EXTENSION_EOF'
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * OpenCode Go Provider Extension for Pi
 * 
 * Registers all OpenCode Go models with Pi agent.
 * Requires OPENCODE_API_KEY environment variable.
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("opencode-go", {
    name: "OpenCode Zen Go",
    baseUrl: "https://opencode.ai/zen/go/v1",
    apiKey: "$OPENCODE_API_KEY",
    api: "openai-completions",
    models: [
      // DeepSeek Models
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash",
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
        input: ["text"],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: "deepseek"
        }
      },
      {
        id: "deepseek-v4-pro",
        name: "DeepSeek V4 Pro",
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
        input: ["text"],
        cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 384000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens",
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: "deepseek"
        }
      },
      // GLM Models
      {
        id: "glm-5.1",
        name: "GLM-5.1",
        reasoning: true,
        input: ["text"],
        cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
        contextWindow: 202752,
        maxTokens: 32768,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens"
        }
      },
      {
        id: "glm-5.2",
        name: "GLM-5.2",
        reasoning: true,
        thinkingLevelMap: { off: null, minimal: null, low: null, medium: null, high: "high", xhigh: "max" },
        input: ["text"],
        cost: { input: 1.4, output: 4.4, cacheRead: 0.26, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 131072,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens"
        }
      },
      // Kimi Models
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        reasoning: true,
        thinkingLevelMap: { minimal: null, low: null, medium: null },
        input: ["text", "image"],
        cost: { input: 0.95, output: 4, cacheRead: 0.16, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 65536,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          thinkingFormat: "deepseek",
          supportsReasoningEffort: false,
          maxTokensField: "max_tokens",
          supportsLongCacheRetention: false
        }
      },
      {
        id: "kimi-k2.7-code",
        name: "Kimi K2.7 Code",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.95, output: 4, cacheRead: 0.19, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 262144,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens"
        }
      },
      // MiMo Models
      {
        id: "mimo-v2.5",
        name: "MiMo V2.5",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 128000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens"
        }
      },
      {
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        reasoning: true,
        input: ["text"],
        cost: { input: 1.74, output: 3.48, cacheRead: 0.0145, cacheWrite: 0 },
        contextWindow: 1048576,
        maxTokens: 128000,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens"
        }
      },
      // MiniMax Models
      {
        id: "minimax-m2.7",
        name: "MiniMax M2.7",
        reasoning: true,
        input: ["text"],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
        contextWindow: 204800,
        maxTokens: 131072,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          maxTokensField: "max_tokens"
        }
      },
      {
        id: "minimax-m3",
        name: "MiniMax M3 (3x usage)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.3, output: 1.2, cacheRead: 0.06, cacheWrite: 0 },
        contextWindow: 1000000,
        maxTokens: 131072,
        api: "anthropic-messages" as const,
        baseUrl: "https://opencode.ai/zen/go"
      },
      // Qwen Models
      {
        id: "qwen3.6-plus",
        name: "Qwen3.6 Plus",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.5, output: 3, cacheRead: 0.05, cacheWrite: 0.625 },
        contextWindow: 1000000,
        maxTokens: 65536,
        compat: {
          supportsStore: false,
          supportsDeveloperRole: false,
          thinkingFormat: "qwen",
          maxTokensField: "max_tokens"
        }
      },
      {
        id: "qwen3.7-max",
        name: "Qwen3.7 Max",
        reasoning: true,
        input: ["text"],
        cost: { input: 2.5, output: 7.5, cacheRead: 0.5, cacheWrite: 3.125 },
        contextWindow: 1000000,
        maxTokens: 65536,
        api: "anthropic-messages" as const,
        baseUrl: "https://opencode.ai/zen/go"
      },
      {
        id: "qwen3.7-plus",
        name: "Qwen3.7 Plus",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.4, output: 1.6, cacheRead: 0.04, cacheWrite: 0.5 },
        contextWindow: 1000000,
        maxTokens: 65536,
        api: "anthropic-messages" as const,
        baseUrl: "https://opencode.ai/zen/go"
      }
    ]
  });

  console.log("[opencode-go] Provider registered with 14 models");
}
EXTENSION_EOF

log "OpenCode Go extension creada"

# =============================================================================
# 5. Configurar Settings por Defecto
# =============================================================================
echo ""
info "Configurando settings por defecto..."

# Verificar si settings.json ya existe
if [ -f ~/.pi/agent/settings.json ]; then
    warn "settings.json ya existe. Creando backup..."
    cp ~/.pi/agent/settings.json ~/.pi/agent/settings.json.backup.$(date +%s)
fi

cat > ~/.pi/agent/settings.json << SETTINGS_EOF
{
  "theme": "dark",
  "defaultProvider": "opencode-go",
  "defaultModel": "mimo-v2.5"
}
SETTINGS_EOF

log "Settings configurados"

# =============================================================================
# 6. Configurar Variables de Entorno
# =============================================================================
echo ""
info "Configurando variables de entorno..."

# Verificar si .bashrc ya tiene OPENCODE_API_KEY
if grep -q "OPENCODE_API_KEY" ~/.bashrc 2>/dev/null; then
    warn "OPENCODE_API_KEY ya está en .bashrc"
else
    echo "" >> ~/.bashrc
    echo "# OpenCode Go API Key" >> ~/.bashrc
    echo "export OPENCODE_API_KEY=\"\$OPENCODE_API_KEY\"" >> ~/.bashrc
    warn "Agrega tu OPENCODE_API_KEY en ~/.bashrc"
    warn "Ejemplo: export OPENCODE_API_KEY='tu-api-key-aqui'"
fi

# Crear archivo de ejemplo
cat > ~/.pi/agent/.env.example << 'ENV_EOF'
# OpenCode Go API Key
# Obtener en: https://opencode.ai/settings/api-keys
OPENCODE_API_KEY=your-api-key-here

# Variables opcionales del proyecto
# PROXY_HOST=
# PROXY_PORT=
# PROXY_USER=
# PROXY_PASS=
ENV_EOF

log "Variables de entorno configuradas"

# =============================================================================
# 7. Verificar Instalación
# =============================================================================
echo ""
info "Verificando instalación..."

# Verificar pi-agent
if command -v pi &> /dev/null; then
    log "Pi Agent disponible: $(pi --version 2>/dev/null || echo 'instalado')"
else
    warn "Pi Agent no encontrado en PATH. Puede necesitar reiniciar la terminal."
fi

# Verificar extension
if [ -f ~/.pi/agent/extensions/opencode-go.ts ]; then
    log "OpenCode Go extension instalada"
else
    error "Extension no encontrada"
fi

# =============================================================================
# 8. Instrucciones Finales
# =============================================================================
echo ""
echo "═══════════════════════════════════════════════════════════════════"
echo "  ✅ Setup Completo"
echo "═══════════════════════════════════════════════════════════════════"
echo ""
echo "  📋 Próximos pasos:"
echo ""
echo "  1. Configura tu API key:"
echo "     nano ~/.bashrc"
echo "     export OPENCODE_API_KEY='tu-api-key'"
echo "     source ~/.bashrc"
echo ""
echo "  2. Verifica los modelos disponibles:"
echo "     pi --list-models"
echo ""
echo "  3. Inicia pi-agent en tu proyecto:"
echo "     cd /path/to/your/project"
echo "     pi"
echo ""
echo "  4. Selecciona el modelo con Ctrl+P o /model"
echo ""
echo "  📚 Modelos disponibles:"
echo "     - mimo-v2.5 (default, barato)"
echo "     - deepseek-v4-flash"
echo "     - deepseek-v4-pro"
echo "     - kimi-k2.7-code"
echo "     - qwen3.7-plus"
echo "     - Y más..."
echo ""
echo "═══════════════════════════════════════════════════════════════════"
