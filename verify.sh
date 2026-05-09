#!/bin/bash
cd /home/admin/orbitalpha-futures-paper || cd e:/antigravity/homepage/orbitalpha-futures-paper

grep -R "HTF_POLICY_BLOCK\|PROBE_ONLY\|ALLOW_WITH_MACRO_RISK\|counter_trend_risk\|htf_size_multiplier\|htf_requires_stronger_confirmation" -n src | head -300

git diff -U80 -- src/engine-v2/market-judgment/detector.ts | sed -n '/htfBias/,+180p'

git diff -U80 -- src/engine-v2/reconciler.ts | sed -n '/HTF_POLICY_BLOCK/,+140p'

npm run build
