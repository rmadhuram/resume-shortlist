// Statistical comparison of Jev vs Claude scores in jev-scored.csv. Prints a text report and writes stats.json.
const fs = require("fs");
const file = process.argv[2] || "jev-scored.csv";
const outJson = process.argv[3] || "stats.json";
const L = fs.readFileSync(file, "utf8").trim().split("\n");
function parse(l){const o=[];let c="",q=false;for(let i=0;i<l.length;i++){const ch=l[i];if(q){if(ch==='"'){if(l[i+1]==='"'){c+='"';i++;}else q=false;}else c+=ch;}else{if(ch==='"')q=true;else if(ch===","){o.push(c);c="";}else c+=ch;}}o.push(c);return o;}
const h = parse(L[0]);
const all = L.slice(1).map(l => Object.fromEntries(h.map((k,i)=>[k, parse(l)[i]])));
const scoredAll = all.filter(r => r.jev_points_total !== "" && r.jev_error === "");
const CLAUDE_COLS = ["points_collegeReputation","points_degree","points_gpa","points_projects","points_bonus","points_total"];
const rows = scoredAll.filter(r => CLAUDE_COLS.every(c => /^\d+$/.test(r[c])));
const claudeIncomplete = scoredAll.length - rows.length;
const DIMS = [["collegeReputation",1,4],["degree",1,3],["gpa",1,4],["projects",1,6],["bonus",0,3],["total",3,20]];

const mean = a => a.reduce((x,y)=>x+y,0)/a.length;
const sd = a => { const m=mean(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1)); };
const median = a => { const s=[...a].sort((x,y)=>x-y); const m=s.length>>1; return s.length%2? s[m] : (s[m-1]+s[m])/2; };
function pearson(a,b){const ma=mean(a),mb=mean(b);let n=0,da=0,db=0;for(let i=0;i<a.length;i++){n+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}return n/Math.sqrt(da*db);}
function ranks(a){const idx=a.map((v,i)=>[v,i]).sort((x,y)=>x[0]-y[0]);const r=new Array(a.length);let i=0;while(i<idx.length){let j=i;while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;const avg=(i+j)/2+1;for(let k=i;k<=j;k++)r[idx[k][1]]=avg;i=j+1;}return r;}
const spearman=(a,b)=>pearson(ranks(a),ranks(b));
function weightedKappa(a,b,lo,hi){const k=hi-lo+1;const O=Array.from({length:k},()=>new Array(k).fill(0));for(let i=0;i<a.length;i++)O[a[i]-lo][b[i]-lo]++;const n=a.length;const ra=O.map(r=>r.reduce((x,y)=>x+y,0));const rb=O[0].map((_,j)=>O.reduce((s,r)=>s+r[j],0));let num=0,den=0;for(let i=0;i<k;i++)for(let j=0;j<k;j++){const w=((i-j)**2)/((k-1)**2);num+=w*O[i][j];den+=w*ra[i]*rb[j]/n;}return {kappa:1-num/den,matrix:O};}
function tTest(d){const m=mean(d),s=sd(d),n=d.length;const t=m/(s/Math.sqrt(n));return {t, df:n-1};}
function dist(a,lo,hi){const c={};for(let v=lo;v<=hi;v++)c[v]=0;for(const x of a)c[x]=(c[x]||0)+1;return c;}

const stats = { file, totalRows: all.length, scored: rows.length,
  skipped: all.filter(r=>r.jev_error.startsWith("skipped")).length,
  failed: all.filter(r=>r.jev_error && !r.jev_error.startsWith("skipped")).length,
  claudeIncomplete, fromPdf: rows.filter(r=>r.jev_state_source==="pdf").length,
  tokens: rows.reduce((s,r)=>s+ +r.jev_tokens_input,0), dims:{} };

console.log(`Rows ${stats.totalRows}: compared ${stats.scored} (${stats.fromPdf} from PDF text); skipped ${stats.skipped} (Claude result was Fail), excluded ${claudeIncomplete} (Claude bonus missing), Jev failures ${stats.failed}. Jev input tokens ${stats.tokens}.\n`);
console.log("dim".padEnd(18)+"claude μ±σ".padStart(13)+"jev μ±σ".padStart(13)+"Δ mean".padStart(8)+"Δ sd".padStart(7)+"MAD".padStart(6)+"exact".padStart(7)+"±1".padStart(7)+"r".padStart(7)+"ρ".padStart(7)+"κw".padStart(7)+"t".padStart(8));
for (const [d,lo,hi] of DIMS) {
  const c = rows.map(r=>+r["points_"+d]), j = rows.map(r=>+r["jev_points_"+d]);
  const diff = j.map((v,i)=>v-c[i]);
  const exact = diff.filter(x=>x===0).length/diff.length, within1 = diff.filter(x=>Math.abs(x)<=1).length/diff.length;
  const wk = weightedKappa(c.map(x=>Math.min(hi,Math.max(lo,x))), j.map(x=>Math.min(hi,Math.max(lo,x))), lo, hi);
  const tt = tTest(diff);
  const s = { claudeMean:mean(c), claudeSd:sd(c), jevMean:mean(j), jevSd:sd(j), diffMean:mean(diff), diffSd:sd(diff), diffMedian:median(diff),
    mad:mean(diff.map(Math.abs)), exact, within1, pearson:pearson(c,j), spearman:spearman(c,j), weightedKappa:wk.kappa, t:tt.t, df:tt.df,
    claudeDist:dist(c,lo,hi), jevDist:dist(j,lo,hi), diffDist:dist(diff,Math.min(...diff),Math.max(...diff)), confusion: d==="total"?null:wk.matrix, lo, hi };
  stats.dims[d] = s;
  console.log(d.padEnd(18)+`${s.claudeMean.toFixed(2)}±${s.claudeSd.toFixed(2)}`.padStart(13)+`${s.jevMean.toFixed(2)}±${s.jevSd.toFixed(2)}`.padStart(13)+s.diffMean.toFixed(2).padStart(8)+s.diffSd.toFixed(2).padStart(7)+s.mad.toFixed(2).padStart(6)+(exact*100).toFixed(0).padStart(6)+"%"+(within1*100).toFixed(0).padStart(6)+"%"+s.pearson.toFixed(2).padStart(7)+s.spearman.toFixed(2).padStart(7)+s.weightedKappa.toFixed(2).padStart(7)+s.t.toFixed(1).padStart(8));
}

// Bland-Altman on totals
const c = rows.map(r=>+r.points_total), j = rows.map(r=>+r.jev_points_total), diff = j.map((v,i)=>v-c[i]);
stats.blandAltman = { bias: mean(diff), loaLow: mean(diff)-1.96*sd(diff), loaHigh: mean(diff)+1.96*sd(diff) };
console.log(`\nTotal: bias ${stats.blandAltman.bias.toFixed(2)}, 95% limits of agreement ${stats.blandAltman.loaLow.toFixed(2)} to ${stats.blandAltman.loaHigh.toFixed(2)}`);
console.log("Total diff distribution (jev - claude):", JSON.stringify(stats.dims.total.diffDist));

// Ranking / shortlist agreement
function topSet(arr, n){return new Set(arr.map((v,i)=>[v,i]).sort((a,b)=>b[0]-a[0]).slice(0,n).map(x=>x[1]));}
stats.topOverlap = {};
for (const n of [25,50,100,200]) { const a=topSet(c,n), b=topSet(j,n); let inter=0; for(const x of a) if(b.has(x)) inter++; stats.topOverlap[n]=inter/n; }
console.log("Top-N overlap (Claude top-N ∩ Jev top-N):", Object.entries(stats.topOverlap).map(([n,v])=>`top${n}=${(v*100).toFixed(0)}%`).join(" "));
stats.threshold = {};
for (const th of [12,13,14,15,16]) { let both=0,cOnly=0,jOnly=0,neither=0; for(let i=0;i<c.length;i++){const a=c[i]>=th,b=j[i]>=th; if(a&&b)both++;else if(a)cOnly++;else if(b)jOnly++;else neither++;}
  const pa=(both+neither)/c.length; const pe=((both+cOnly)*(both+jOnly)+(jOnly+neither)*(cOnly+neither))/(c.length**2); stats.threshold[th]={both,cOnly,jOnly,neither,agreement:pa,kappa:(pa-pe)/(1-pe)}; }
console.log("Shortlist agreement at total >= T:"); for (const [th,v] of Object.entries(stats.threshold)) console.log(`  T=${th}: both ${v.both}, Claude-only ${v.cOnly}, Jev-only ${v.jOnly}, neither ${v.neither}; agreement ${(v.agreement*100).toFixed(1)}%, κ ${v.kappa.toFixed(2)}`);

// Confidence vs agreement
stats.confidence = {};
for (const [d,col] of [["collegeReputation","jev_college_confidence"],["projects","jev_projects_confidence"]]) {
  const buckets=[[0,0.5],[0.5,0.7],[0.7,0.9],[0.9,1.01]]; stats.confidence[d]=[];
  for (const [lo,hi] of buckets) { const rs=rows.filter(r=>+r[col]>=lo&&+r[col]<hi); if(!rs.length){stats.confidence[d].push({lo,hi,n:0});continue;} const ex=rs.filter(r=>r["points_"+d]===r["jev_points_"+d]).length/rs.length; const mad=mean(rs.map(r=>Math.abs(r["points_"+d]-r["jev_points_"+d]))); stats.confidence[d].push({lo,hi,n:rs.length,exact:ex,mad}); }
  console.log(`Confidence vs agreement for ${d}:`, stats.confidence[d].map(b=>`[${b.lo},${b.hi>1?1:b.hi}) n=${b.n} exact=${b.n?(b.exact*100).toFixed(0)+"%":"-"} MAD=${b.n?b.mad.toFixed(2):"-"}`).join(" | "));
  const conf=rows.map(r=>+r[col]); console.log(`  mean confidence ${mean(conf).toFixed(2)}, median ${median(conf).toFixed(2)}, share < 0.5: ${(conf.filter(x=>x<0.5).length/conf.length*100).toFixed(1)}%`);
}

// Biggest disagreements
const big = rows.map(r=>({name:r.name,college:r.college,c:+r.points_total,j:+r.jev_points_total,d:+r.jev_points_total-+r.points_total,
  dims:DIMS.slice(0,5).map(([k])=>`${k.slice(0,4)} ${r["points_"+k]}→${r["jev_points_"+k]}`).join(", ")})).sort((a,b)=>Math.abs(b.d)-Math.abs(a.d)).slice(0,10);
stats.biggest = big;
console.log("\nLargest disagreements:"); for (const b of big) console.log(`  ${b.name} (${b.college}): ${b.c}→${b.j} (${b.d>0?"+":""}${b.d}) [${b.dims}]`);

// Degree/bonus component detail
const cBonusDist = dist(rows.map(r=>+r.points_bonus),0,3), jBonusDist = dist(rows.map(r=>+r.jev_points_bonus),0,3);
console.log("\nBonus distribution Claude:", JSON.stringify(cBonusDist), " Jev:", JSON.stringify(jBonusDist));
// Claude total x Jev total count grid, and per-row records for the page
stats.totalMatrix = {}; for (let i=0;i<c.length;i++){ const k=c[i]+","+j[i]; stats.totalMatrix[k]=(stats.totalMatrix[k]||0)+1; }
stats.confidenceHist = {};
for (const [d,col] of [["college","jev_college_confidence"],["projects","jev_projects_confidence"]]) { const bins=new Array(10).fill(0); for (const r of rows){ const v=Math.min(9,Math.floor(+r[col]*10)); bins[v]++; } stats.confidenceHist[d]=bins; }
fs.writeFileSync(outJson, JSON.stringify(stats, null, 2));
console.log(`\nStats written to ${outJson}`);
