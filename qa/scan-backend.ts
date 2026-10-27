import { detectDangerousBackendCapabilities } from "/home/syhekate/Lumiverse/src/spindle/manager.service";
for (const f of Bun.argv.slice(2)) console.log(f, JSON.stringify(detectDangerousBackendCapabilities(await Bun.file(f).text())));
// negative control
console.log("control", JSON.stringify(detectDangerousBackendCapabilities('const b = Buffer.from(x, "base64"); eval("1");')));
process.exit(0);
