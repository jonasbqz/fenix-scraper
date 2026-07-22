// test.ts
import { ProxyAgent, fetch as undiciFetch } from "undici";

// ⚠️ Bloque IPv6 del VPS de Hetzner (/64)
// Cada usuario mapea a una IP diferente dentro del rango
const VPS_BASE = "2a01:4ff:f4:4280";
const PUERTO_HTTP = 3128;
const PASSWORD = "30923176X2026Xx";

async function probar(ipIndex: number): Promise<string> {
    const usuario = `user${ipIndex}`;
    // IPv6 completa: base + sufijo del usuario (en hex)
    const suffix = ipIndex.toString(16).padStart(4, '0');
    const ipv6 = `${VPS_BASE}::${suffix}`;
    const proxyUrl = `http://${usuario}:${PASSWORD}@[${ipv6}]:${PUERTO_HTTP}`;

    console.log(`🚀 Probando con ${usuario} (${ipv6})...`);

    try {
        const agent = new ProxyAgent({
            uri: proxyUrl,
            requestTls: { rejectUnauthorized: false },
        });

        const res = await undiciFetch("https://api64.ipify.org?format=json", {
            dispatcher: agent,
        });
        const data = (await res.json()) as { ip: string };
        console.log(`  ✅ IP de salida: ${data.ip}`);
        return data.ip;
    } catch (err) {
        console.error(`  ❌ Error:`, err);
        return "ERROR";
    }
}

async function main() {
    console.log("═══════════════════════════════════════════");
    console.log("  Test de proxy IPv6 — VPS Hetzner");
    console.log("═══════════════════════════════════════════\n");

    const results: { user: string; ip: string }[] = [];

    for (const idx of [1, 50, 99]) {
        const ip = await probar(idx);
        results.push({ user: `user${idx}`, ip });
    }

    console.log("═══════════════════════════════════════════");
    console.log("  Resumen");
    console.log("═══════════════════════════════════════════");

    const uniqueIPs = new Set(results.map((r) => r.ip));
    for (const r of results) {
        console.log(`  ${r.user} → ${r.ip}`);
    }
    console.log();
    if (uniqueIPs.size === results.length) {
        console.log(`  ✅ Rotación FUNCIONANDO — ${uniqueIPs.size} IPs únicas`);
    } else {
        console.log(
            `  ⚠️  Rotación NO funciona — ${uniqueIPs.size} IP(s) única(s) de ${results.length} intentos`
        );
        console.log(`  → Revisa la configuración de Squid en el VPS`);
    }
    console.log();
}

main();
