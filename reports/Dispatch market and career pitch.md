# Dispatch sells the operations, not the classifier

Research date: 26 Oct 2026. Built from four sets of research notes. Source labels: **[primary]** = the company's own page or a named expert; **[news]** = press; **[weak]** = vendor blog, stats aggregator, or a source with unclear method. Treat [weak] numbers as rough direction only.

## Key takeaways

1. **Ticket triage is a commodity feature in 2026.** Zendesk, Intercom, Salesforce and Freshworks all bundle it, and investor money goes to bots that *resolve* tickets, not ones that sort them. A "ticket classifier" proves little on its own. What Dispatch has that these vendors don't show publicly is everything around the call: evals, rollback, traces and fallback.
2. **Dispatch sits in a real, funded market called LLMOps** (the tools and practices for running LLM features in production). In 2026 there were acquisitions (Langfuse by ClickHouse, Promptfoo by OpenAI, Helicone by Mintlify) and big funding rounds (OpenRouter at $1.3B, Braintrust at $800M). Dispatch's gateway copies the *reliability* half of a commercial gateway. It skips the *budgets and governance* half on purpose.
3. **Hiring demand is real, but it favours people who look production-ready.** "AI engineer" topped LinkedIn's 2026 Jobs on the Rise list, yet young software developer employment fell about 20% from its 2022 peak. Job ads ask for "production/shipped" experience (39%) and evals (23%) far more often than for a portfolio (17%).
4. **Pitch it as "the model call is one line; everything around it is the project."** Lead with numbers that have baselines (eval accuracy, failover success, rollback time, p95 latency, cost per 1,000 tickets). State the test conditions in every number: synthetic traffic, mock provider, n tickets.
5. **The biggest gaps are prompt-injection defence, PII handling, real-user error analysis and Python.** Each has a cheap fix that fits the current rules. Each fix is an idea that would need its own spec, not a task to start now.

---

## 1. The support-triage market: big money, but not for triage

**What it is:** Nobody publishes a credible size for "ticket triage" alone. It is counted inside bigger markets, and those estimates disagree by up to about 2x.

| Signal | Number | Source, date |
|---|---|---|
| AI for customer service market | $15.12B in 2026, 25.8% yearly growth (CAGR) | [Azumo](https://azumo.com/artificial-intelligence/ai-insights/ai-in-customer-service-statistics), [Ringly](https://www.ringly.io/blog/ai-customer-service-statistics-2026), 2026 **[weak]**: firm behind it unclear |
| Help desk software market | $14.3B (2025) to $29.3B by 2033, 9.4% CAGR | [SkyQuest via GII](https://www.gii.tw/report/sky1964660-help-desk-software-market-size-share-growth.html) **[weak]**: paywalled method |
| Salesforce Agentforce ARR (yearly recurring revenue) | $800M (Jan 2026) to >$1.5B (Jul 2026) | [Salesforce Q2 FY27 release](https://seekingalpha.com/pr/20631301), Sep 2026 **[primary]**. Not like-for-like: Slackbot was folded in |
| Sierra (AI support agents) | $950M raised at $15.8B valuation; >$150M ARR | [Quartz](https://qz.com/sierra-ai-funding-round-950-million-valuation-050426), May 2026 **[news]** |
| Decagon | $250M at $4.5B valuation | [Sacra](https://sacra.com/c/decagon/), Jan 2026 **[weak]** |
| Freshworks support-side (Freshdesk) ARR | $400M, only +4% | [Freshworks release](https://www.freshworks.com/pressrelease/freshworks-reports-record-second-quarter-2026-results/), Aug 2026 **[primary]** |

**How vendors charge:** per resolved ticket, on top of seat fees. Intercom Fin costs $0.99 per outcome ([Intercom pricing](https://www.intercom.com/pricing), Oct 2026 **[primary]**). Salesforce charges $2 per conversation or $0.10 per action ([Salesforce](https://www.salesforce.com/news/press-releases/2025/05/15/agentforce-flexible-pricing-news/), May 2025 **[primary]**). Zendesk's per-resolution fee is unpublished and estimated at about $1–2 ([eesel.ai](https://www.eesel.ai/blog/zendesk-automated-resolutions), 2026 **[weak]**, competitor). A single triage call costs a fraction of a cent, so the profit comes from the platform and the trust around the call, not from the call itself. That matches Dispatch's idea.

**What buyers worry about:** trust and control.
- 64% of 5,728 customers would rather companies didn't use AI for service ([Gartner via cxm.world](https://cxm.world/cxm-news/customers-dont-want-ai-in-customer-service-report-claims/), Jul 2024 **[news]**).
- Only 20% of 321 service leaders actually cut staff because of AI ([Gartner](https://www.gartner.com/en/newsroom/press-releases/2025-12-02-gartner-survey-finds-only-20-percent-of-customer-service-leaders-report-ai-driven-headcount-reduction), Dec 2025 **[primary]**).
- Zendesk renamed its triage field "Intent" to "Topic" in June 2026. That rename touches customers' triggers, SLAs and API code ([Zendesk](https://support.zendesk.com/hc/en-us/articles/4550640560538-Automatically-triaging-tickets-based-on-intent-language-and-sentiment) **[primary]**). It is a small, real example of why teams want classification they version and control.

**Public failures map to Dispatch's controls.** These are useful in interviews:

| Incident | What went wrong | Dispatch control |
|---|---|---|
| Air Canada, Feb 2024 | Bot invented a refund policy; airline held liable ([CX Network](https://www.cxnetwork.com/artificial-intelligence/news/chatbot-hallucination-backlash) **[news]**) | Closed-label JSON output plus eval gate |
| Cursor, Apr 2025 | Support bot invented a login policy ([Fortune](https://fortune.com/article/customer-support-ai-cursor-went-rogue) **[news]**) | Same |
| Klarna, 2025 | Reversed AI-only support after quality complaints ([CX Network](https://www.cxnetwork.com/artificial-intelligence/news/chatbot-hallucination-backlash) **[news]**) | Canary plus rollback |
| OpenAI outage, 10 Jun 2025 | API errors for hours ([OpenAI status](https://status.openai.com/incidents/01JZTMDZ7AF5HN0WFCVGF58ZNN) **[primary]**) | Fallback to a second provider |

None of these was a triage mislabel. Triage errors are quiet: tickets just sit in the wrong queue. That is a good argument for tracking accuracy per field over time.

## 2. Where Dispatch fits in LLMOps: the reliability half of a gateway

**Terms.** A **gateway** is the one layer every model call passes through, which handles retries, fallback and logging. A **circuit breaker** stops calling a provider that keeps failing for a short time, so you fail fast instead of waiting. **Jitter** adds a random wait to retries so they don't all hit the provider at the same moment.

**The market in 2026:**

| Company | Event | Source, date |
|---|---|---|
| OpenRouter (hosted router) | $113M Series B at $1.3B valuation | [TechCrunch](https://techcrunch.com/2026/05/26/openrouter-more-than-doubles-valuation-to-1-3b-in-a-year), May 2026 **[news]** |
| Portkey (gateway) | $15M Series A; claims 24,000+ organizations | [Entrepreneur India](https://india.entrepreneur.com/news-and-trends/portkey-raises-usd-15-mn-in-series-a-led-by-elevation/502850), Feb 2026 **[news]** |
| LiteLLM (open-source gateway) | Package hacked on PyPI in Mar 2026, and again on 21 Oct 2026 | [Datadog Security Labs](https://securitylabs.datadoghq.com/articles/litellm-compromised-pypi-teampcp-supply-chain-campaign/) **[primary]**. The October attack is from search summaries; check before quoting |
| Langfuse (tracing, Dispatch uses it) | Bought by ClickHouse; stays open source | [ClickHouse](https://clickhouse.com/blog/clickhouse-acquires-langfuse-open-source-llm-observability), Jan 2026 **[primary]** |
| Braintrust (evals) | $80M at $800M valuation; Notion, Stripe and Zapier are customers | [Axios](https://www.axios.com/pro/enterprise-software-deals/2026/02/17/ai-observability-braintrust-80-million-800-million), Feb 2026 **[news]** |
| Promptfoo (evals) | Bought by OpenAI | [TechCrunch via Yahoo](https://finance.yahoo.com/news/openai-acquires-promptfoo-secure-ai-174904138.html), Mar 2026 **[news]** |
| Helicone (tracing) | Bought by Mintlify; now maintenance only | [Dealroom](https://ai-startups.dealroom.co/news/feed/mintlify-acquires-open-source-ai-observability-platform-helicone), Mar 2026 **[news]** |

Analyst estimates for the 2026 LLM-observability market range from $1.8B to $3.9B, all from paywalled firms ([Research and Markets](https://www.researchandmarkets.com/reports/6215671/large-language-model-llm-observability), [NextMSC](https://www.nextmsc.com/report/ai-observability-market-ic5403) **[weak]**). Point to the funding list instead.

**What Dispatch covers and what it leaves out:**

| Feature the market sells | Dispatch |
|---|---|
| One API for many providers; fallback; retries; per-call timeouts | Yes |
| Retry only 429, 5xx and timeouts; honour Retry-After | Yes. This is stricter than most |
| Circuit breaker per provider | Yes |
| Typed error names shared by metrics, logs and traces | Yes. **No vendor markets this** |
| Schema check plus a repair retry | Yes. **Not a gateway feature anywhere found** |
| Mock provider that can fail on command (fault injection) | Yes. **None found in the market** |
| Exact-match cache | Yes (SQLite) |
| Semantic cache, per-key budgets, virtual keys, guardrails, SSO, 400+ models | No, on purpose |

(Comparison built from the vendor docs in the notes, e.g. [LiteLLM docs](https://docs.litellm.ai/docs/simple_proxy) **[primary]**.)

**Expect the question "why not LiteLLM?"** Nearly all build-vs-buy advice says buy, but it comes from vendors who sell gateways ([Eden AI](https://www.edenai.co/post/litellm-vs-hosted-ai-gateway-the-2026-build-or-buy-guide), [Portkey](https://portkey.ai/blog/build-vs-buy-llm-gateways/) **[weak]**). A good answer:
- "It's small on purpose. I built it to understand what LiteLLM does inside."
- "It sits behind one function, so swapping in LiteLLM is a one-file change."
- "LiteLLM's package was hacked twice in 2026, and a gateway holds every provider key. A small dependency surface has value."

**Other trends to use:**
- **Eval gates in CI are now standard advice.** Braintrust and Promptfoo both ship GitHub Actions for them ([Braintrust](https://www.braintrust.dev/articles/llm-eval-pipeline-github-actions) **[primary]**).
- **Automatic canary rollback for prompts is rare in public write-ups.** A **canary** sends a small share of traffic to a new version first. Few companies show the whole loop in public ([Flagsmith](https://flagsmith.com/blog/progressive-delivery-llm-powered-features) **[weak]**). That makes it a strong signal.
- **OpenTelemetry's GenAI naming rules are still not stable** (status "Development" as of Jul 2026). Key renames: `gen_ai.system` → `gen_ai.provider.name`, `prompt_tokens` → `input_tokens` ([dev.to](https://dev.to/azena-ai/opentelemetrys-genai-semantic-conventions-are-not-stable-yet-heres-what-actually-shipped-in-2026-3mke) **[weak]**). Using the current names shows you follow the spec. Datadog reads these names directly too ([Datadog](https://datadoghq.com/blog/llm-otel-semantic-convention/) **[primary]**), so Dispatch's traces could move to another backend.

## 3. Hiring: demand is high, the junior door is narrow

**Demand**

| Signal | Number | Source, date |
|---|---|---|
| LinkedIn Jobs on the Rise 2026 | "AI engineer" is #1 | [HR Leader](https://www.hrleader.com.au/business/27698-ai-engineer-tops-linkedin-s-2026-jobs-on-the-rise-list), Jan 2026 **[news]** |
| US job posts mentioning AI | 3.21% (Jul 2025) to 6.28% (Jul 2026) | [Dror Poleg / Indeed data](https://data.drorpoleg.com/charts/ai-postings-country/) **[weak]**: not fetched directly |
| Young software developer jobs | down about 20% from the late-2022 peak | [Stanford Digital Economy Lab](https://digitaleconomy.stanford.edu/news/canaries-interest-rates-and-timinga-more-on-recent-drivers-of-employment-changes-for-young-workers), Aug 2025 / Feb 2026 **[primary]** |
| AI engineer listings that are senior | about 80% | [Interview Query](https://www.interviewquery.com/p/why-ai-engineering-jobs-are-exploding-2025) **[weak]** |
| "AI Engineer" as a new-grad title | growing while "Software Engineer" shrinks | [Gusto](https://gusto.com/resources/gusto-insights/new-grad-hiring-report-2026), 2026 **[primary]** |

**Skills asked for.** Square1AI studied 315 AI/ML job ads from Jul–Sep 2026 ([Square1AI](https://www.square1ai.com/research/what-ai-job-ads-ask-for-2026), Sep 2026; small sample):

| Skill | Share of ads | Dispatch? |
|---|---|---|
| Agents | 39% | No. VerifAI covers this |
| "Production / shipped" | 39% | **Yes, this is the core of Dispatch** |
| Python | 38% | No (see gaps) |
| LLMs | 34% | Yes |
| Evals | 23% | Yes |
| TypeScript/JavaScript | 19% | Yes |
| Monitoring/observability | 17% | Yes |
| Portfolio/GitHub asked for | 17% | n/a |
| RAG | 11% | No |
| CI/CD | 10% | Yes |
| Kubernetes | 8% | No |

LLMOps postings read almost like Dispatch's feature list: "evaluation pipelines, observability for AI systems, cost management for LLM usage" ([Virtual Vocations](https://www.virtualvocations.com/job/senior-llmops-engineer-2858841-i.html) **[weak]**). Hamel Husain calls evals the interview "weed-out" stage ([Maven](https://maven.com/p/07e7c7/cracking-the-ai-evals-interview) **[primary]**). Dispatch and VerifAI together cover the two biggest clusters: production plus evals, and agents.

**Is TypeScript a problem?** Mildly. Python is asked for about twice as often (38% vs 19%, Square1AI above). TypeScript became the #1 language on GitHub in Aug 2025 ([GitHub Octoverse](https://github.blog/news-insights/octoverse/octoverse-a-new-developer-joins-github-every-second-as-ai-leads-typescript-to-1/), Oct 2025 **[primary]**). It is close to neutral for product AI and LLMOps roles, and a minus for ML-platform and research roles.

**Salaries**

| Market | Number | Source, date |
|---|---|---|
| US AI engineer, average total pay | ~$245k; AI premium over non-AI: 6% at entry level to 19% at staff | [levels.fyi](https://www.levels.fyi/blog/ai-engineer-compensation-trends-q3-2025.html), 2025; sample size not given |
| US LLMOps engineer | entry $120–160k, mid $160–230k | [GetPro](https://www.getpro.co/en/jobs/llmops-engineer) **[weak]** |
| US AI SRE | average $178k (p25 $135k, p75 $232k) | [orbytjobs](https://www.orbytjobs.ai/salary/ai-site-reliability-engineer), 2026 **[weak]** |
| Anthropic Forward Deployed Engineer (top end) | $280–320k | [Welcome to the Jungle](https://app.welcometothejungle.com/jobs/WNvfb_kS) **[primary posting]** |
| Remote developer living in Pakistan | median $43,163/yr | [Plane](https://plane.com/salaries/software-developer/pakistan), undated **[weak]** |
| Remote, nearby markets | India $48,918; Bangladesh $41,465 (expected pay) | [Arc.dev](https://arc.dev/salaries/software-engineers-in-india) **[weak]**: self-reported |
| Pakistan local AI engineer | median PKR 2.35M/yr (about $8.4k at ~PKR 280/USD, a rough unsourced rate); p75 PKR 5.28M | [levels.fyi Pakistan](https://www.levels.fyi/t/software-engineer/title/ai-engineer/locations/pakistan), 26 Oct 2026; small sample |

**What this means for you:** remote USD work pays about 4–6x the local median. For a junior or mid-level remote role from Pakistan, a realistic target is **roughly $25–60k**, not US on-site figures. This is an inference from the rows above, not a sourced range.

## 4. The pitch

**Rules from people who hire.** Louis-François Bouchard hires for shipped products, evals "against baselines with quantitative results", and decisions you can defend. His red flag is "a generic GPT wrapper with no user, business value, or evaluation" ([Bouchard](https://www.louisbouchard.ai/what-i-look-for-when-hiring-ai-engineers/), Mar/Aug 2026 **[primary]**). DataTalks.Club guests say to name the user, the pain and the business cost *before* the model ([DataTalks.Club](https://datatalksclub.github.io/podwiki/wiki/ai-engineering-portfolio-projects/) **[primary]**). Arslan Ahmad lists a "tiny AI feature… smart classification" as a project type that gets callbacks, because it uses AI "as bounded tool, not magic solution" ([Substack](https://arslandg.substack.com/p/3-portfolio-projects-that-actually), May 2026 **[weak]**).

### One line

> Dispatch: a support-ticket triage service that keeps working when its AI provider fails, and that can't ship a worse prompt. The model call is one line; the project is everything that runs it.

### 30 seconds

> Support teams need every ticket sorted fast, even when the AI provider is down, and they need to know a prompt change didn't quietly make things worse. Dispatch does one deliberately simple model call, ticket in and JSON out. The project is the operations around it. I built my own gateway with retries, fallback from Gemini to Cohere, and a circuit breaker. There's a CI gate that blocks a pull request if accuracy drops on my hand-labelled test set, and a canary that rolls a bad prompt back on its own. Traces, SLO dashboards, load tests, a cost model and a postmortem complete it. In a failover drill it stayed at [X]% success. The gate blocked a real bad PR. Rollback took [M] seconds.

### Resume bullets (fill the brackets from `results/`; never round up)

Formula: "Accomplished X, measured by Y, by doing Z", with a baseline next to every number ([Laszlo Bock via Business Insider](https://www.businessinsider.in/Googles-former-HR-boss-says-this-is-the-key-to-a-perfect-resume/articleshow/54925993.cms), 2014 **[primary]**). Every number states its test conditions. Never write "users" or "production traffic" ([techinterview.org](https://www.techinterview.org/post/3233474610/side-projects-open-source-engineering-resume/?format=md) **[weak]**: "avoid synthetic or inflated metrics").

- Built a CI eval gate on a hand-labelled, versioned golden set (~270 tickets, fixed dev/test split, test n ≈ [70]). It blocked a prompt PR that dropped both-fields accuracy from [A]% to [B]% (threshold: [2] pts or the measured noise floor).
- Kept triage at [X]% success (n = [N] requests, baseline [Y]% with no fallback) through a simulated primary-provider outage, using a TypeScript LLM gateway with timeouts, jittered retries (only on 429/5xx/timeouts), a per-provider circuit breaker and Gemini→Cohere fallback.
- Cut rollback of a bad prompt from a redeploy ([D] min) to [M] s, with a Redis-backed canary at [P]% traffic that rolls back automatically on criteria written in advance (p95, error rate, schema-valid rate). Shown in a rehearsed drill.
- Measured p50/p95/p99 latency of [a]/[b]/[c] ms at [R] req/s (k6, uncached calls, mock provider) and an estimated cost of $[Y] per 1,000 tickets (list prices dated [date]). A trimmed prompt cut input tokens by [Z]% with accuracy within noise.
- Wrote the runbook and a blameless postmortem of a real incident from the build, in Google SRE format.

(**p95** = 95% of requests are faster than this number. **SLO** = the reliability target you promise, e.g. 99% of calls succeed. **Burn rate** = how fast you are using up the failures that target allows.)

### README first screen

Structure: user and pain, numbers with baselines, a video link, one command that runs with no keys ([Bouchard](https://www.louisbouchard.ai/what-i-look-for-when-hiring-ai-engineers/): "honest README", reproducible setup).

```
# Dispatch
Sorts support tickets into category, priority and summary, and keeps
working when the AI provider doesn't. The model call is one line.
This repo is everything a team needs to run it.

| Measure (conditions)                         | Result | Baseline |
| Accuracy, both fields (test split, n=[70])   | [B]%   | [A]% (v1 prompt) |
| Success during provider outage (drill, n=[N])| [X]%   | [Y]% without fallback |
| Bad prompt rollback (canary drill)           | [M] s  | redeploy, [D] min |
| p95 latency (uncached, mock, [R] rps)        | [b] ms | — |
| Cost per 1,000 tickets (list price, [date])  | $[Y]   | free tier: $0 |

▶ 3-minute demo · Postmortem · Runbook · Why not LiteLLM?
docker compose up   # runs on the mock provider, no keys needed
```

Below the first screen: an architecture diagram, a "Why not X" section (why not LiteLLM or Portkey, why not an agent framework, why not an LLM judge for fixed labels), and "Limitations" (synthetic traffic, free tiers, one region, one person labelled the data).

### Demo video (under 3 minutes; show failure, not just the happy path)

The 2–3 minute length comes from a single undated guide ([Notion guide](https://nifty-bottle-d69.notion.site/Recording-your-video-demo-21402808315080c1830ae411f29eb768) **[weak]**).

| Time | Show |
|---|---|
| 0:00–0:15 | The pain, and the one line |
| 0:15–0:45 | One ticket in, JSON out, its Langfuse trace with `prompt_version`, `model`, `git_sha` |
| 0:45–1:30 | Failover drill: mock returns 500s, breaker opens, traffic moves to fallback, Grafana success line stays flat |
| 1:30–2:15 | Eval gate blocks a bad PR (show the table), then a canary rolls back on its own |
| 2:15–2:45 | Cost and latency table with baselines, then the limits |

### Interview stories it supports

"Design an LLM gateway" is a real question in question banks (Reddit, Point72 per [Dataford](https://dataford.io/questions/design-a-scalable-llm-gateway-for-reddit-that-handles-rate-limiting-token-management-and-intelligent-failover) **[weak]**: user-reported).

| Question | Your story |
|---|---|
| Design an LLM gateway | Retry rules by error class, breaker states, fallback, typed errors, mock fault injection |
| How do you evaluate an LLM feature? | Golden set, dev/test split by hash, pure-function graders, noise floor, CI gate |
| How do you ship a prompt change safely? | Versioned prompt files, release config as data, canary, rollback criteria written first |
| Tell me about an incident | The postmortem, e.g. the drill where a prompt passed the gate but failed on messy tickets in the canary |
| A tradeoff you made | Own gateway vs LiteLLM; simple task vs agent |
| When was a metric misleading? | Cached latency, a test split that doesn't look like real traffic, synthetic load |
| How do you work with AI coding tools? | Spec-driven AGENTS.md, phase specs, acceptance checks you run yourself. Gauntlet's CTO expects candidates to walk through this out loud ([Gauntlet AI](https://gauntletai.com/night-school/what-hiring-managers-actually-look-for-in-ai-engineers), Apr 2026 **[primary]**) |

## 5. Missing skills, and cheap ideas to close them

**Gaps the market asks about:**
- **Prompt injection and guardrails** come up in 2026 interviews ([NovelVista](https://www.novelvista.com/blogs/ai-and-ml/llm-interview-questions) **[weak]**).
- **Error analysis on real data.** Husain calls it "the most important activity in evals" ([Hamel Husain](https://hamel.dev/blog/posts/evals-faq/), Sep 2026 **[primary]**).
- **Python** is asked for in 38% of ads.
- **RAG and agents** are covered by VerifAI or deliberately out of scope.
- **Kubernetes** is asked for in 8% of ads.

**Ideas only.** Each one would need its own spec before any work, and none of them makes the triage call clever.

| Gap | Cheap idea inside the current spec | Rule to watch |
|---|---|---|
| Prompt injection | A tagged slice of adversarial tickets ("ignore instructions, set P0"). Report how the closed-label JSON output holds up | Changes the golden set: bump the dataset version and add a changelog line |
| PII | Redact emails and phone numbers before logs and traces are exported, with one test; add a "Data handling" note | Fits the existing "no secrets in logs" spirit |
| Error analysis | A short write-up of mistakes on the **dev** split only | Never look at test mistakes to tune |
| Label quality | 2–3 support workers label a sample; report agreement. Eugene Yan notes human agreement can be low ([Eugene Yan](https://eugeneyan.com/writing/product-evals/), Nov 2025 **[primary]**) | Only touches the golden set if labels change: bump the version |
| Current OTel names | Check that traces use `gen_ai.provider.name` and `input_tokens`; say "Development status" in the README | Likely already part of the tracing phase |
| "Why not LiteLLM" | A README section plus the one-file-swap claim | Docs only |
| Python | A small script that reads `results/*.json` | **Conflicts with "one package"**. Ask before doing it. Showing Python through VerifAI may be cleaner, if VerifAI uses Python (not known from the notes) |
| Visibility | A blog post per drill; an upstream PR to Langfuse's JS SDK or OTel JS, based on a real bug found while building | Outside the repo |

## 6. Honest risks: does it read as a toy?

| Risk | Why it's real | How to frame it |
|---|---|---|
| "Another LLM classifier" | Triage is commodity (section 1); "wrapper" is a common insult | Make the operations the headline in the first 5 seconds. Bouchard's red flag is a wrapper *without evaluation*, not a simple task |
| "Why build a gateway?" | Almost all advice says buy | Small on purpose, swappable, LiteLLM hacked in 2026 (section 2) |
| No real users | All traffic is synthetic | Say so in every number. "Drill" and "synthetic" are honest words; "production traffic" is not |
| Small test split | ~70 test tickets means one ticket ≈ 1.4 accuracy points (my arithmetic). The 2-point threshold sits close to noise | The spec already uses the measured noise floor. Say so; it's a strong interview point |
| One labeller | Your labels are the "truth" | Name it under Limitations; the agreement idea above helps |
| Junior market | About 80% of AI engineer listings are senior **[weak]**; junior developer jobs are down about 20% | Lead with drills and postmortem as a substitute for job experience; target "AI engineer" titles, which are growing at entry level |
| TypeScript only | Python is asked for twice as often | Target product AI and LLMOps roles, where TS is neutral |

**Verdict:** It reads as a toy only if the README leads with the classifier. With the operations, numbers with baselines and a postmortem up front, it hits most signals that hiring writing names: shipped, measured, observable, defensible.

## Conclusion

Triage being commoditized helps you. Because the task is solved and simple, any reviewer can judge the engineering without arguing about the model. The market is paying for trustworthy operation (Portkey, Braintrust and Langfuse all raised money or were bought in 2026), and that is exactly the half of the stack Dispatch builds.

What will decide the outcome is honesty in the numbers, not the number of features. A gate that blocked a real PR, a drill with n and a baseline, and a postmortem with a real root cause are rare in junior portfolios. Inflated or unlabelled metrics would erase that advantage. Spend the final phase on the README's first screen and the video as much as on the code.

**Not found in the research:** a reliable size for the triage market alone, first-hand hiring-manager views on custom gateways, and Pakistan-specific remote AI salary surveys (P@SHA, Deel).
