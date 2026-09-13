/**
 * tests/build-benchmark-cases.ts — build the MT benchmark case set (40 cases).
 *
 * Uses pdfjs-dist getTextContent() to pull paragraphs from the source PDF,
 * groups them into blocks, then a curated spec selects representative cases
 * across 9 categories. Line-break hyphenation and a handful of known
 * justified-text run-together artifacts are cleaned.
 *
 * Output: tests/benchmark-cases.json
 *
 * Run (repo root):
 *   node_modules\.bin\esbuild tests/build-benchmark-cases.ts --bundle --platform=node \
 *     --format=cjs --outfile=tests/out/build-benchmark-cases.cjs \
 *     --external:pdfjs-dist --external:pdf-lib --external:@pdf-lib/fontkit \
 *     --external:electron --external:node-llama-cpp
 *   node tests/out/build-benchmark-cases.cjs
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as pdfjsNamespace from 'pdfjs-dist/legacy/build/pdf.js'

const pdfjsLib = (pdfjsNamespace as any).default ?? pdfjsNamespace

const PDF_PATH = path.join(process.cwd(), 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf')
const OUT_PATH = path.join(process.cwd(), 'tests', 'benchmark-cases.json')

interface RawPara { page: number; text: string; words: number; lines: number; fontSize: number }
interface Span { str: string; y: number; x: number; fontSize: number }

function isTextItem(item: any): item is { str: string; transform: number[] } {
  return typeof item === 'object' && item !== null && typeof item.str === 'string' && Array.isArray(item.transform)
}
const wc = (t: string) => t.trim().split(/\s+/).filter(Boolean).length

function clean(text: string): string {
  let t = text
  t = t.replace(/([a-z])-\s+([a-z])/g, '$1$2')
  t = t.replace(/\s+/g, ' ').trim()
  t = t.replace(/^\(?continued\)?\s*/i, '')
  t = t.replace(/^\d{1,3}(chapter|part)\d?[a-z]?\s*/i, '')
  // known justified-text run-together artifacts
  const fixes: [RegExp, string][] = [
    [/FOSTERINGVISION/gi, 'Fostering vision'],
    [/DELEGATINGEFFECTIVELY/gi, 'Delegating effectively'],
    [/FEELINGGUILTYABOUTOFFLOADINGWORKTOOTHERS/gi, 'Feeling guilty about offloading work to others'],
    [/FINDMENTORS/gi, 'Find mentors'],
    [/Akanksha Guptais/gi, 'Akanksha Gupta is'],
    [/involvesinterview/gi, 'involves interview'],
    [/mentorshipplatformssuchasPlato/gi, 'mentorship platforms such as Plato']
  ]
  for (const [re, to] of fixes) t = t.replace(re, to)
  return t.trim()
}

async function extractAll(): Promise<RawPara[]> {
  const data = new Uint8Array(fs.readFileSync(PDF_PATH))
  const pdf = await pdfjsLib.getDocument({ data, isEvalSupported: false, useSystemFonts: true }).promise
  const paras: RawPara[] = []
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const tc = await page.getTextContent()
    const spans: Span[] = []
    for (const raw of tc.items) {
      if (!isTextItem(raw) || raw.str.trim() === '') continue
      const tm = raw.transform
      spans.push({ str: raw.str, y: tm[5], x: tm[4], fontSize: Math.abs(tm[3] || 0) })
    }
    const lines: { y: number; spans: Span[] }[] = []
    for (const s of spans) {
      const f = lines.find((l) => Math.abs(l.y - s.y) < 2)
      if (f) f.spans.push(s); else lines.push({ y: s.y, spans: [s] })
    }
    lines.sort((a, b) => b.y - a.y)
    for (const l of lines) l.spans.sort((a, b) => a.x - b.x)
    const lineTexts = lines.map((l) => ({
      y: l.y, fontSize: l.spans[0]?.fontSize ?? 0,
      text: l.spans.map((s) => s.str).join('').trim()
    }))
    let cur: { y: number; fontSize: number; parts: string[] } | null = null
    let prevY: number | null = null
    for (const lt of lineTexts) {
      if (!lt.text) continue
      const gap = prevY === null ? 0 : prevY - lt.y
      const needBreak = cur === null || gap > 16 || Math.abs(lt.fontSize - cur.fontSize) > 2
      if (needBreak) {
        if (cur) { const text = clean(cur.parts.join(' ')); if (text) paras.push({ page: p, text, words: wc(text), lines: cur.parts.length, fontSize: cur.fontSize }) }
        cur = { y: lt.y, fontSize: lt.fontSize, parts: [lt.text] }
      } else cur.parts.push(lt.text)
      prevY = lt.y
    }
    if (cur) { const text = clean(cur.parts.join(' ')); if (text) paras.push({ page: p, text, words: wc(text), lines: cur.parts.length, fontSize: cur.fontSize }) }
    await page.cleanup()
  }
  await pdf.destroy()
  return paras
}

interface Pick {
  id: string; category: string; source_page: number; prefix: string
  expected_notes: string; override?: string
}

const PICKS: Pick[] = [
  // --- technical body paragraphs (8) ---
  { id: 'tech-body-01', category: 'technical-body', source_page: 30, prefix: 'EM is a versatile role', expected_notes: 'EM = engineering manager; keep CTO/SRE/DevOps acronyms' },
  { id: 'tech-body-02', category: 'technical-body', source_page: 32, prefix: 'performance reviews, resource allocation', expected_notes: 'staff/principal engineer, solution architect titles' },
  { id: 'tech-body-03', category: 'technical-body', source_page: 288, prefix: 'The tech industry has experienced', expected_notes: 'keep two URLs intact; on-call/run book; OE',
    override: 'The tech industry has experienced a significant cultural shift with the advent of DevOps, which aims to integrate development and operations functions. DevOps promotes collaboration and communication between development and deployment teams to prevent friction and ensure smoother application delivery. In simple terms, DevOps combines software development and operations to maintain stable systems proactively rather than address problems reactively. It emphasizes identifying root causes to prevent recurring problems and encourages continuous improvement. DevOps initiatives encompass various practices, including enhancing the on-call process, documenting run books, prioritizing security in development, adhering to coding best practices, optimizing services, conducting defect triage exercises, and improving reporting. Although DevOps is not a one-size-fits-all solution, it underscores the importance of being transparent, setting goals, and advocating for continuous improvement within the organization. Additionally, DevOps recognizes the need to balance maintaining existing systems with building new ones, ensuring that improvements are made where necessary. Two sources I suggest reading are The Phoenix Project (https://mng.bz/oeld) and the Amazon Web Services (AWS) blog post about DevOps at https://aws.amazon.com/devops/what-is-devops. DevOps practices ensure that systems degrade gracefully under unexpected or unprepared loads.' },
  { id: 'tech-body-04', category: 'technical-body', source_page: 18, prefix: 'As you can see, there was a noticeable lack', expected_notes: 'IC = individual contributor; EM; LinkedIn' },
  { id: 'tech-body-05', category: 'technical-body', source_page: 45, prefix: 'These metrics offer valuable insights', expected_notes: 'technical debt; on-call; SRE; developer velocity' },
  { id: 'tech-body-06', category: 'technical-body', source_page: 44, prefix: 'Indeed, you can explore numerous avenues', expected_notes: 'development velocity; story points; downtime' },
  { id: 'tech-body-07', category: 'technical-body', source_page: 40, prefix: 'DELEGATINGEFFECTIVELY', expected_notes: 'delegation; micromanagement; tech lead',
    override: 'Delegating effectively. Effective delegation for an EM involves understanding team members’ career goals and assigning relevant tasks to propel their progress. First, you must recognize the value of empowering individuals; then you must build trust with your team members while avoiding micromanagement. Alice and Bob, our two senior engineers turned EMs, faced initial challenges in delegating tasks and responsibilities. Alice empowered her tech lead to collaborate with other teams, an act that demonstrated her trust in the tech lead’s abilities. Conversely, Bob’s reluctance to delegate meant that he was the only point of contact with other teams, which confused and frustrated team members and hindered their success.' },
  { id: 'tech-body-08', category: 'technical-body', source_page: 35, prefix: 'Effective delegation not only boosts morale', expected_notes: 'delegation; career aspirations; chapter 5' },

  // --- long / difficult multi-clause sentences (5) ---
  { id: 'long-sent-01', category: 'long-sentence', source_page: 30, prefix: 'training sessions, along with cross-training', expected_notes: 'long enumeration; EM titles; ~300 words' },
  { id: 'long-sent-02', category: 'long-sentence', source_page: 238, prefix: 'structured framework that enables project planners', expected_notes: 'escalation chain On-call->EM->Director; SLA; Jira; Slack/Teams; ~400 words' },
  { id: 'long-sent-03', category: 'long-sentence', source_page: 237, prefix: 'expectations. It sets the tone', expected_notes: 'Scrum artifacts: grooming, sprint planning, retrospective, Scrum of scrums; QA; ~390 words' },
  { id: 'long-sent-04', category: 'long-sentence', source_page: 70, prefix: 'Set clear scope and mission', expected_notes: 'imperative bullets; IC->EM transition; ~370 words',
    override: 'Set clear scope and mission. Define a clear scope and mission for the hiring process to give engineers a road map and a sense of how their work adds value to the company. Ensure that engineers see a clear path for their work to prevent frustration and maintain motivation. Use network and recruiters. Use your network and collaborate with a recruiter to find the best engineers for the team. Seek support and learn from others. Seek guidance and support from your manager, mentors, and allies. Learn from their experiences to avoid common pitfalls and accelerate your team-building process. Avoid mass hiring. Resist the temptation to hire a large number of people at the same time. Take gradual steps, regularly assessing the team’s needs to maintain efficiency and work lean. You are transitioning from IC to EM on your current team. Transitioning into an engineering management role within your current team presents its own challenges and opportunities. Build trust gradually. Patiently build trust before officially assuming the role. Address biases and fair treatment. Be mindful of biases from your previous IC role. Treat all team members fairly, avoiding favoritism. Continue learning. Stay informed about unconscious biases. Attend diversity and inclusion workshops. Handle challenges proactively. Be prepared for potential challenges and skepticism. Address concerns openly and honestly. Be open to learning. Recognize this period as a valuable opportunity to learn leadership skills.' },
  { id: 'long-sent-05', category: 'long-sentence', source_page: 136, prefix: 'FEELINGGUILTYABOUTOFFLOADING', expected_notes: 'delegation guilt; accountability; long clauses',
    override: 'Feeling guilty about offloading work to others. EMs may experience guilt when delegating tasks originally planned for themselves, but it’s crucial to understand that delegating tasks empowers others and contributes to their growth. Instead of feeling guilty, EMs should view delegation as a positive step. Furthermore, delegation doesn’t absolve EMs of accountability. Although not all tasks need to be done exclusively by EMs, the managers remain accountable for ensuring that tasks are completed on time and accurately. It’s essential to discern which tasks require the EM’s involvement, particularly in people management, and which can be delegated appropriately. When new tasks arise, delegating them to an engineer can affect team velocity and focus.' },

  // --- short paragraphs (4) ---
  { id: 'short-01', category: 'short', source_page: 21, prefix: 'First, let', expected_notes: 'very short opener; keep colon' },
  { id: 'short-02', category: 'short', source_page: 22, prefix: 'This book contains 15 chapters', expected_notes: 'parenthetical people/product/process' },
  { id: 'short-03', category: 'short', source_page: 33, prefix: 'FOSTERINGVISION', expected_notes: 'fostering vision; mission statement',
    override: 'Fostering vision. For an EM, fostering a clear vision significantly enhances team productivity. It is your responsibility to impart a clear mission statement to your team by translating the organization-wide strategy and vision. This approach ensures that your team understands its purpose as a cohesive unit.' },
  { id: 'short-04', category: 'short', source_page: 42, prefix: 'These areas are interconnected', expected_notes: 'developer velocity; business metrics' },

  // --- code / command / procedure dense (4) ---
  { id: 'code-01', category: 'code-command', source_page: 101, prefix: '3.2.8Avoiding burnout', expected_notes: 'section number 3.2.8; imperative checklist lead-in',
    override: '3.2.8 Avoiding burnout. Avoiding burnout is crucial, especially in virtual work environments where clear boundaries may be lacking. Burnout can occur due to various factors such as excessive workload, lack of motivation, and personal problems. Here are some strategies to prevent burnout on your team:' },
  { id: 'code-02', category: 'code-command', source_page: 122, prefix: '4.4.1Identifying high performance', expected_notes: 'section number 4.4.1; imperative lead-in',
    override: '4.4.1 Identifying high performance. Identifying high performers is crucial, as they consistently exceed expectations, boost team velocity, and inspire others. They are sought after in the job market and serve as go-to resources within the team. Recognizing their traits also helps set a benchmark for hiring top talent. Let us explore these traits further:' },
  { id: 'code-03', category: 'code-command', source_page: 196, prefix: 'Engineering team cost', expected_notes: 'keep dollar figures and arithmetic: $100,000, $8,300/2, $5,400, $21,600, $30,000',
    override: 'Engineering team cost—This cost involves interview loops, which are calls with potential candidates. Let’s assume that each engineer makes roughly $100,000 and that 4 engineer loops are done for 10 potential candidates before the prime candidate is found. Roughly, each engineer spent 2 hours per candidate, so 4 engineers x 10 candidates x 2 hours = 80 hours = 2 weeks, or $8,300 / 2 = $4,150. Total—The costs in this scenario add up to $1,250 + $4,150 = $5,400. Onboarding cost—includes training cost: suppose that we used an internal/external trainer for 2 days who charged $5,000. Ramp-up period—the engineer was given 60 days to ramp up to the new technology stack and the company culture, at a cost of $100,000 x (2/12) = $16,600. Total—$5,000 + $16,600 = $21,600. Miscellaneous costs—job ads, tools to filter resumes = $3,000. Grand total—all the above result in a total of $30,000 in backfill cost.' },
  { id: 'code-04', category: 'code-command', source_page: 297, prefix: 'How will my team', expected_notes: 'numbered question list 1./2.',
    override: '1. How will my team or organization benefit from DevOps? 2. What are the current pain points on my team(s) that focusing on DevOps might address?' },

  // --- heading hierarchy (4) ---
  { id: 'heading-h1', category: 'heading', source_page: 29, prefix: 'Exploring the', expected_notes: 'chapter title; keep casing', override: 'Exploring the engineering manager role' },
  { id: 'heading-h2', category: 'heading', source_page: 30, prefix: '1.1Demystifying', expected_notes: 'section number 1.1', override: '1.1 Demystifying the EM role' },
  { id: 'heading-h3', category: 'heading', source_page: 40, prefix: 'DELEGATINGEFFECTIVELY', expected_notes: 'subsection title', override: 'Delegating effectively' },
  { id: 'heading-h4', category: 'heading', source_page: 33, prefix: 'FOSTERINGVISION', expected_notes: 'sub-subsection title', override: 'Fostering vision' },

  // --- list / bullet items (4) ---
  { id: 'list-01', category: 'list-item', source_page: 18, prefix: 'The Manager', expected_notes: 'book title; author Camille Fournier', override: 'The Manager’s Path: A Guide for Tech Leaders Navigating Growth and Change, by Camille Fournier' },
  { id: 'list-02', category: 'list-item', source_page: 18, prefix: 'The Mythical Man-Month', expected_notes: 'book title; author Frederick P. Brooks Jr.', override: 'The Mythical Man-Month: Essays on Software Engineering, by Frederick P. Brooks Jr.' },
  { id: 'list-03', category: 'list-item', source_page: 18, prefix: 'Software Engineering at Google', expected_notes: 'book title; keep "Google"', override: 'Software Engineering at Google: Lessons Learned from Programming Over Time' },
  { id: 'list-04', category: 'list-item', source_page: 18, prefix: 'Peopleware', expected_notes: 'book title; authors DeMarco and Lister', override: 'Peopleware: Productive Projects and Teams, by Tom DeMarco and Timothy Lister' },

  // --- management / business (4) ---
  { id: 'mgmt-business-01', category: 'management-business', source_page: 31, prefix: 'This friction can compromise', expected_notes: 'startup vs large corp; hierarchy; bureaucracy' },
  { id: 'mgmt-business-02', category: 'management-business', source_page: 47, prefix: 'Meet Charlie', expected_notes: 'delegative leadership; load-testing; hands-off' },
  { id: 'mgmt-business-03', category: 'management-business', source_page: 50, prefix: 'Choosing a leadership style is highly situational', expected_notes: 'autocratic/transformational/transactional; hackathon' },
  { id: 'mgmt-business-04', category: 'management-business', source_page: 24, prefix: 'Akanksha Guptais', expected_notes: 'proper nouns: Amazon-AWS, Audible, Microsoft, Robinhood, Columbia; LinkedIn URL',
    override: 'Akanksha Gupta is an experienced EM who has worked at several big tech firms, including Amazon-AWS, Audible, Microsoft, and Robinhood, where she led full stack teams. She holds a master’s degree in computer science from Columbia University in New York. She served as a jury member for several esteemed awards and is an active mentor in the GrowthMentor, Plato, and First Round Fast Track mentorship programs. She has spoken at multiple global tech conferences and is a big advocate for women in technology. To find out more about her, find her on LinkedIn (https://www.linkedin.com/in/akankshaguptamgr).' },

  // --- acronym / terminology dense (4) ---
  { id: 'acronym-01', category: 'acronym-dense', source_page: 43, prefix: 'Measuring the success of an EM', expected_notes: 'DORA metrics; keep two URLs; DevOps Research and Assessment',
    override: 'Measuring the success of an EM involves carefully choosing the metrics based on the work situation and company. Your team’s development velocity (https://mng.bz/y8Z7) can help you measure success. DORA metrics (https://codeclimate.com/blog/dora-metrics), proposed by the DevOps Research and Assessment team, is another way to measure the success of your engineering team and your own success. It includes four key metrics:' },
  { id: 'acronym-02', category: 'acronym-dense', source_page: 48, prefix: 'Transformational leaders', expected_notes: 'DevOps/DevSecOps; enterprise architect; rearchitecture',
    override: 'Transformational leaders, often associated with roles such as enterprise architect and DevOps/DevSecOps team, play a crucial role in driving growth and change within a company. Carefully balancing this leadership style with other styles is essential, however, because focusing solely on the future without addressing present needs can lead to unintended consequences. Proposing a complete rearchitecture of a core infrastructure piece, although beneficial for the future, might strain resources and time needed for ongoing operational excellence.' },
  { id: 'acronym-03', category: 'acronym-dense', source_page: 62, prefix: 'David, a senior engineer', expected_notes: 'EM, IC, tech lead, one-on-one, 90-day plan; keep proper noun David' },
  { id: 'acronym-04', category: 'acronym-dense', source_page: 65, prefix: 'FINDMENTORS', expected_notes: 'IC->EM; keep three URLs (Plato, GrowthMentor, Fast Track)',
    override: 'Find mentors. Securing mentors during your transition from IC to EM is crucial for success. Seek mentors inside and outside your company who have experience in this transition. Use mentorship platforms such as Plato (https://www.platohq.com), GrowthMentor (https://www.growthmentor.com), and Fast Track (https://fasttrack.firstround.com), or attend local meetups and networking sessions. Use LinkedIn to reach out for mentorship, aiming to find someone who is invested in your career growth.' },

  // --- numeric / data dense (3) ---
  { id: 'data-01', category: 'data-numeric', source_page: 156, prefix: '360-degree recognition', expected_notes: '360-degree feedback; top-down/peer; anonymity' },
  { id: 'data-02', category: 'data-numeric', source_page: 324, prefix: 'The Pomodoro Technique', expected_notes: 'keep numbers: 1980, 30-minute, 25 minutes, 5-minute break, 15 minutes; keep URL' },
  { id: 'data-03', category: 'data-numeric', source_page: 43, prefix: 'The success of an EM can be measured', expected_notes: 'keep percentages 20% and 30%; business metrics; stakeholders/vendors' }
]

async function main() {
  console.log('Extracting from', PDF_PATH)
  const paras = await extractAll()
  console.log('Total paragraphs:', paras.length)

  const cases: any[] = []
  const misses: string[] = []
  for (const pick of PICKS) {
    const hit = paras.find(
      (p) => p.page === pick.source_page &&
        p.text.replace(/\s+/g, '').toLowerCase().startsWith(pick.prefix.replace(/\s+/g, '').toLowerCase())
    )
    const english_text = pick.override ?? hit?.text
    if (!english_text) { misses.push(pick.id + ' (p' + pick.source_page + ' ~ ' + pick.prefix + ')'); continue }
    cases.push({
      id: pick.id,
      category: pick.category,
      source_page: pick.source_page,
      english_text: english_text.trim(),
      expected_notes: pick.expected_notes
    })
  }
  if (misses.length) { console.error('MISSES:'); misses.forEach((m) => console.error('  -', m)); process.exitCode = 1 }

  fs.writeFileSync(OUT_PATH, JSON.stringify({
    meta: {
      source: 'Manning.Think.Like.a.Software.Engineering.Manager.2024.6.pdf',
      totalCases: cases.length,
      note: 'MT benchmark cases. english_text is the source; expected_notes lists key terms a good translation must preserve.'
    },
    cases
  }, null, 2))
  console.log('Wrote', OUT_PATH, '(' + cases.length + ' cases)')
  const byCat: Record<string, number> = {}
  for (const c of cases) byCat[c.category] = (byCat[c.category] ?? 0) + 1
  console.log('By category:', byCat)
}
main().catch((e) => { console.error(e); process.exit(1) })
