import fs from "fs";
import path from "path";
import { LogInterpreter } from "../src/engine/log-interpreter";
import { PolicyTuner } from "../src/engine/policy-tuner";

/**
 * CLI Script: analyze-logs.ts
 * 
 * Usage: npx ts-node scripts/analyze-logs.ts [logDir]
 */
async function main() {
    const logDir = process.argv[2] || path.join(process.cwd(), "logs");
    const outputDir = path.join(process.cwd(), "reports");

    if (!fs.existsSync(logDir)) {
        console.error(`Log directory not found: ${logDir}`);
        process.exit(1);
    }

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const interpreter = new LogInterpreter({ logDir, outputDir });
    const tuner = new PolicyTuner({ minEpisodeCountForAnalysis: 10 });

    console.log(`Scanning logs in: ${logDir}...`);

    // Find all .log or .jsonl files in logDir/archive or logDir
    const files = fs.readdirSync(logDir).filter(f => f.endsWith(".log") || f.endsWith(".jsonl"));

    const episodes = await interpreter.run(files);
    console.log(`Reconstructed ${episodes.length} episodes.`);

    const report = tuner.generateReport(episodes);

    const reportPath = path.join(outputDir, `policy-report-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

    console.log(`\n=== Policy Tuning Report ===`);
    console.log(`Total Episodes: ${report.totalEpisodes}`);
    console.log(`Win Rate: ${(report.winRate * 100).toFixed(1)}%`);
    console.log(`\nSuggestions:`);
    report.suggestions.forEach((s, i) => {
        console.log(`${i + 1}. [${s.parameter}] -> ${s.suggestedValue}`);
        console.log(`   Reason: ${s.reason}`);
        console.log(`   Confidence: ${s.confidence}`);
    });

    console.log(`\nFull report saved to: ${reportPath}`);
}

main().catch(console.error);
