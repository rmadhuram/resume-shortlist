// Re-scores rows of processed.csv with TypeSafe AI's Jev model.
//
// For each CSV row the matching PDF is located in the DIR_OUTPUT letter folders (where index.ts copied
// it as <Name_with_underscores>_<original>.pdf), its text is extracted, and that text plus the fields
// Claude already extracted (college, degree, gpa, interests, summary) become the Jev "state". Jev
// answers the rubric questions; GPA points are computed in code (Jev is documented as weak at numeric
// comparison). No Claude call is made. Rows without a readable PDF fall back to CSV fields only.
//
// Usage: npm run jev -- [--in <DIR_OUTPUT>/processed.csv] [--out jev-scored.csv] [--pdf-dir <DIR_OUTPUT>]
//                      [--limit N] [--concurrency 8] [--dry-run]

import dotenv from "dotenv";
import fs from "fs";
import { TypeSafeClient, noul, score, type JsonValue } from "@typesafe-ai/sdk";
import { extractTextFromPdf } from "./pdf-extract";
dotenv.config();

// ---------- CLI ----------
const argv = process.argv.slice(2);
function flag(name: string, fallback: string): string {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const PDF_DIR = flag("pdf-dir", process.env.DIR_OUTPUT || "output");
const DEFAULT_IN = fs.existsSync(PDF_DIR + "/processed.csv") ? PDF_DIR + "/processed.csv" : "processed.csv";
const IN_FILE = flag("in", DEFAULT_IN);
const OUT_FILE = flag("out", "jev-scored.csv");
const LIMIT = parseInt(flag("limit", "0"), 10);
const CONCURRENCY = parseInt(flag("concurrency", "8"), 10);
const DRY_RUN = argv.includes("--dry-run");
const MAX_RESUME_CHARS = 30000; // well under Jev's 32k-token state limit

// ---------- CSV ----------
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { quoted = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

type Row = Record<string, string>;

function readCsv(path: string): { header: string[]; rows: Row[] } {
  const lines = fs.readFileSync(path, "utf8").split(/\r?\n/).filter(l => l.length > 0);
  const header = parseCsvLine(lines[0]);
  const rows = lines.slice(1).map((line, idx) => {
    const cells = parseCsvLine(line);
    if (cells.length !== header.length) {
      throw new Error(`Row ${idx + 2} has ${cells.length} cells, expected ${header.length}`);
    }
    return Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  });
  return { header, rows };
}

// ---------- Jev questions (the rubric from anthropic.ts, decomposed) ----------
const QUESTIONS = {
  collegeReputation: score(
    "How reputed is the candidate's college for engineering in India?",
    [
      { summary: "Little-known or unranked college", signals: ["Obscure private college", "Unaffiliated or unclear institution"] },
      { summary: "Ordinary regional or state college", signals: ["Typical affiliated engineering college", "No notable national ranking"] },
      { summary: "Well-regarded university or top private institute", signals: ["VIT, BITS, Amrita, Manipal, SRM, KL, Chitkara, state flagship universities", "Known nationally but not IIT/NIT/IIIT"] },
      { summary: "Premier national institute: IIT, NIT, or IIIT", signals: ["Any IIT, NIT, or IIIT campus"] },
    ] as const,
  ),
  isEngineeringDegree: noul(
    "The candidate is pursuing or holds an engineering degree (B.E., B.Tech, M.E., or M.Tech)",
    { true: "B.E, B.E., B.Tech, BTech, M.E, M.Tech, Bachelor/Master of Engineering or Technology", false: "MCA, BCA, B.Sc, M.Sc, BBA, or any non-engineering degree" },
  ),
  isCseOrIt: noul(
    "The candidate's branch or specialization is Computer Science, CSE, IT, or a close variant (AI/ML, Data Science, Software Engineering)",
    { true: "CSE, CS, IT, AI & DS, AIML, Software Engineering branch", false: "ECE, EEE, Mechanical, Civil, Electronics/Telecommunication, or branch not indicated" },
  ),
  projects: score(
    "How motivated is the candidate, judged by the quality and originality of the projects and initiative described in the resume?",
    [
      { summary: "No meaningful projects or initiative described" },
      { summary: "Only cookie-cutter or course projects", signals: ["To-do app, portfolio site, basic CRUD, tutorial clones", "Nothing beyond coursework"] },
      { summary: "Common projects with some effort", signals: ["Standard ML or web projects with real data", "Certifications but little building"] },
      { summary: "Good, self-directed projects", signals: ["Non-trivial systems or deployed applications", "Internship work, hackathon entries, open source contributions"] },
      { summary: "Strong projects showing depth and ownership", signals: ["Original problem choice, measurable results", "Published paper, hackathon wins, sustained open-source work"] },
      { summary: "Exceptional, standout work", signals: ["Research-grade or production-grade work rare for a student", "Multiple independent achievements"] },
    ] as const,
  ),
  bonusContest: noul(
    "The candidate has participated in an elite programming contest such as ACM ICPC, Google Code Jam, or a national olympiad",
    { true: "ACM ICPC regionals or finals, Code Jam, Kick Start, INOI/IOI, Hash Code", false: "No elite contest mentioned; college-level hackathons alone do not count" },
  ),
  bonusCompetitive: noul(
    "The candidate has a good standing on a competitive programming platform such as LeetCode, Codeforces, CodeChef, or HackerRank",
    { true: "Rating, rank, star level, or large solved count mentioned", false: "Platform not mentioned, or mentioned without any standing" },
  ),
  bonusExtracurricular: noul(
    "The candidate has stellar extra-curricular activities or notable achievements outside coursework",
    { true: "Leadership roles, national-level awards, publications, notable volunteering or sports achievements", false: "Nothing notable, or only routine club membership" },
  ),
};

const NOUL_THRESHOLD = 0.5;

function gpaPoints(gpaText: string, projectsPoints: number): number {
  const gpa = parseFloat(gpaText);
  if (isNaN(gpa)) {
    // Rubric: "If GPA is not mentioned, prorate it based on motivation & projects."
    return Math.min(4, Math.max(1, Math.round((projectsPoints / 6) * 4)));
  }
  if (gpa >= 9) return 4;
  if (gpa >= 8) return 3;
  if (gpa >= 7) return 2;
  return 1;
}

// ---------- PDF lookup ----------
// index.ts copied each PDF to <DIR_OUTPUT>/<FirstLetter>/<Name_with_underscores>_<original>.pdf.
// The original filename is not in the CSV, so match by name prefix; when several files share the
// prefix (duplicate uploads, or "Avinash Kumar" vs "Avinash Kumar Rai"), prefer the one containing
// the row's phone number.
async function findResumeText(row: Row): Promise<{ file: string; text: string } | null> {
  if (!row.name) return null;
  const dir = `${PDF_DIR}/${row.name[0].toUpperCase()}`;
  const prefix = row.name.replace(/ /g, "_") + "_";
  let candidates: string[] = [];
  try {
    candidates = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.toLowerCase().endsWith(".pdf"));
  } catch {
    return null;
  }
  if (candidates.length === 0) return null;

  const texts: { file: string; text: string }[] = [];
  for (const file of candidates) {
    try {
      texts.push({ file, text: await extractTextFromPdf(`${dir}/${file}`) });
    } catch (err) {
      console.error(`Could not read ${dir}/${file}:`, err instanceof Error ? err.message : err);
    }
  }
  const usable = texts.filter(t => t.text.trim().length >= 100);
  if (usable.length === 0) return null;
  if (usable.length === 1) return usable[0];

  const phone = (row.phone || "").replace(/\D/g, "").slice(-10);
  if (phone.length >= 8) {
    const byPhone = usable.find(t => t.text.replace(/\D/g, "").includes(phone));
    if (byPhone) return byPhone;
  }
  return usable[0];
}

function buildState(row: Row, resumeText?: string): { [key: string]: JsonValue } {
  const extracted = {
    college: row.college,
    city: row.city,
    degree: row.degree,
    year_of_study: row.year,
    gpa_out_of_10: row.gpa,
    interests: [row.interest1, row.interest2, row.interest3].filter(x => x && x !== "Unknown"),
    evaluation_summary: row.summary,
  };
  if (!resumeText) return { extracted_fields: extracted };
  return {
    resume_text: resumeText.trim().slice(0, MAX_RESUME_CHARS),
    extracted_fields: extracted,
  };
}

const JEV_COLUMNS = [
  "jev_points_collegeReputation", "jev_points_degree", "jev_points_gpa", "jev_points_projects", "jev_points_bonus",
  "jev_points_total", "jev_college_raw", "jev_college_confidence", "jev_projects_raw", "jev_projects_confidence",
  "jev_tokens_input", "jev_model", "jev_state_source", "jev_pdf_file", "jev_error",
];

async function scoreRow(client: TypeSafeClient, row: Row): Promise<Record<string, string | number>> {
  const resume = await findResumeText(row);
  const { answers, usage, model } = await client.systemOne({
    state: buildState(row, resume?.text),
    questions: QUESTIONS,
  });

  const college = Math.round(answers.collegeReputation.score) + 1;               // 1..4
  const degree = (answers.isEngineeringDegree.noul >= NOUL_THRESHOLD ? 2 : 1)
    + (answers.isCseOrIt.noul >= NOUL_THRESHOLD ? 1 : 0);                        // 1..3
  const projects = Math.round(answers.projects.score) + 1;                       // 1..6
  const gpa = gpaPoints(row.gpa, projects);                                      // 1..4
  const bonus = [answers.bonusContest, answers.bonusCompetitive, answers.bonusExtracurricular]
    .filter(a => a.noul >= NOUL_THRESHOLD).length;                              // 0..3

  return {
    jev_points_collegeReputation: college,
    jev_points_degree: degree,
    jev_points_gpa: gpa,
    jev_points_projects: projects,
    jev_points_bonus: bonus,
    jev_points_total: college + degree + gpa + projects + bonus,
    jev_college_raw: answers.collegeReputation.score.toFixed(2),
    jev_college_confidence: answers.collegeReputation.confidence.toFixed(2),
    jev_projects_raw: answers.projects.score.toFixed(2),
    jev_projects_confidence: answers.projects.confidence.toFixed(2),
    jev_tokens_input: usage.input_tokens,
    jev_model: model,
    jev_state_source: resume ? "pdf" : "csv",
    jev_pdf_file: resume?.file ?? "",
    jev_error: "",
  };
}

async function main() {
  const { header, rows } = readCsv(IN_FILE);
  const todo = LIMIT > 0 ? rows.slice(0, LIMIT) : rows;
  console.log(`Read ${rows.length} rows from ${IN_FILE}; scoring ${todo.length}`);

  if (DRY_RUN) {
    console.log("Dry run. State for first row:");
    const resume = await findResumeText(todo[0]);
    const state = buildState(todo[0], resume?.text);
    if (typeof state.resume_text === "string") state.resume_text = state.resume_text.slice(0, 400) + " ...[truncated for display]";
    console.log(`PDF: ${resume?.file ?? "none found; CSV-only state"}`);
    console.log(JSON.stringify(state, null, 2));
    console.log("Questions:");
    console.log(JSON.stringify(QUESTIONS, null, 2));
    return;
  }
  if (!process.env.TYPESAFE_API_KEY) {
    console.error("TYPESAFE_API_KEY is not set. Add it to .env (see .env.sample).");
    process.exit(1);
  }

  // Full resumes take longer than the SDK's 10 s default per-attempt timeout under concurrency.
  const client = new TypeSafeClient({ timeout: 60000, retry: { maxRetries: 4 } });
  const results: Record<string, string | number>[] = new Array(todo.length);
  let next = 0;
  let done = 0;
  let failed = 0;
  let tokens = 0;

  async function worker() {
    while (next < todo.length) {
      const i = next++;
      const row = todo[i];
      if (row.result !== "Success") {
        results[i] = { jev_error: "skipped: original result was not Success" };
      } else {
        try {
          results[i] = await scoreRow(client, row);
          tokens += Number(results[i].jev_tokens_input);
        } catch (err) {
          failed++;
          results[i] = { jev_error: String(err instanceof Error ? err.message : err) };
          console.error(`Row ${i + 2} (${row.name}) failed:`, err instanceof Error ? err.message : err);
        }
      }
      done++;
      if (done % 25 === 0 || done === todo.length) console.log(`${done}/${todo.length} done`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const outHeader = [...header, ...JEV_COLUMNS];
  const lines = [outHeader.join(",")];
  todo.forEach((row, i) => {
    const r = results[i];
    lines.push(outHeader.map(h => csvCell(h in row ? row[h] : (r[h] ?? ""))).join(","));
  });
  fs.writeFileSync(OUT_FILE, lines.join("\n") + "\n");

  // Agreement with the original Claude totals, for a quick sanity check.
  const scored = todo.map((row, i) => ({ row, r: results[i] })).filter(x => x.r.jev_points_total !== undefined);
  const diffs = scored.map(x => Number(x.r.jev_points_total) - Number(x.row.points_total));
  const meanDiff = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
  const within2 = diffs.filter(d => Math.abs(d) <= 2).length;
  const fromPdf = scored.filter(x => x.r.jev_state_source === "pdf").length;
  console.log(`Wrote ${OUT_FILE}. Scored ${scored.length} (${fromPdf} with resume text, ${scored.length - fromPdf} CSV-only), failed ${failed}, input tokens ${tokens}.`);
  if (scored.length) {
    console.log(`Jev total minus Claude total: mean ${meanDiff.toFixed(2)}, within ±2 for ${within2}/${scored.length} rows.`);
  }
}

main();
