# Agrippa operating model

Version 0.1 · 14 Oct 2026 · Status: agreed direction, details will change

**Agrippa solves:** businesses can't get operational AI built into how they actually run without an expensive, one-off consultancy project that nobody maintains afterwards.

**Rule:** every unit, project and module has a one-sentence **Solves:** line, a clear, identifiable goal. If it can't be written in one sentence, it isn't ready to build.

---

## The model in one paragraph
A free or cheap **Meetings module** gets Agrippa into a business and shows management a measurable win within a week. That win earns a **paid engagement**: Agrippa engineers go in, map the business's decisions, and build a custom setup. Every custom setup is built on the **Agrippa platform**: a shared **build layer** (ontology, connections, actions, AI) and a **delivery layer** (Apollo: versions, rollouts, rollback) that keeps every client's setup updated from one place. What repeats across clients is promoted into a growing **library** of modules and industry packs, so each engagement is faster than the last.

Modelled on Palantir (quick win → forward-deployed engineers → one platform) and Long Lake (nail one workflow, then expand; capture the diffs; hold for the long term).

---

## Units of the business

### 1. Win the client (go-to-market)
| Unit | Solves |
|---|---|
| Meetings module (the wedge) | Management can't see the value of AI until they experience a simple, low-risk win in their own business. |
| Management value report | A win nobody can measure doesn't open doors: it turns the wedge into hours saved and actions completed. |
| Sales conversation | Turns proven value into the decision to invest in a custom engagement. |
| Paid engagement | Funds the custom build and puts engineers inside the business. |

### 2. Deliver (forward-deployed engineering)
| Unit | Solves |
|---|---|
| Discovery | Teams build the wrong thing when they start from technology instead of the business's recurring decisions. |
| Company ontology | Every business names and structures its world differently; this captures theirs as data the platform understands. |
| Custom build | Each business needs its own workflows without creating a separate codebase to maintain. |
| First win in 5 days | Long projects lose momentum and trust; a real result on real data in five days keeps both. |
| Weekly diff review | AI quality drifts unless what it proposed is compared with what people actually did, every week. |

### 3. Platform: build layer (Agrippa's Foundry)
| Unit | Solves |
|---|---|
| Accounts and isolation | Clients won't trust a shared platform unless their data is provably walled off from everyone else's. |
| Ontology engine | Modules need a common language for business things while each company keeps its own names and fields. |
| Connections hub | Without one place to connect each app once, every module would need its own logins and integration code. |
| Intake queue | New work arrives from many apps; modules need one reliable stream to listen to. |
| Action engine | AI that acts on a business must be approved, labelled and auditable, or nobody will let it act. |
| AI layer | Model calls scattered through the code can't be versioned, tested, costed or swapped. |
| Assistant (chat bar) | Users need one place to ask for any change instead of learning every screen. |
| Memory | The platform must learn each business's people, preferences and habits or it never gets smarter. |
| Audit and diff log | Without a record of who approved what and what changed, there's no trust and no learning. |

### 4. Platform: delivery layer (Agrippa's Apollo)
| Unit | Solves |
|---|---|
| Module versions and channels | Fifty custom setups become fifty maintenance jobs unless every client runs a known, managed version. |
| Staged rollout and rollback | A bad update shouldn't hit every client at once, and must be undoable in one click. |
| Client health view | Problems need to be spotted per client before the client notices them. |
| Dedicated deployments | Some clients will require their own environment; it must run the same code, not a fork. |

### 5. Library and learning
| Unit | Solves |
|---|---|
| Library modules | Each new client shouldn't need common workflows rebuilt from scratch. |
| Client-private modules | Some needs are unique to one client but must still run on the shared platform. |
| Industry packs | Businesses in one industry share vocabulary and rules that shouldn't be re-entered every time. |
| Telemetry (anonymous) | You can't improve what you can't see, but clients' content must stay private. |
| Cross-client insights | Patterns that only show up across many clients stay invisible client by client. |
| Promotion rule | Without a rule for what moves into the library, the platform either bloats or never grows. |

### 6. Company
| Unit | Solves |
|---|---|
| Founding docs | Decisions get relitigated and builds drift unless the rules are written down. |
| Operating model (this doc) | Everyone needs the same picture of how the business makes money and delivers. |
| Brand and trademark check | Building on a name someone else owns risks a forced rebrand after launch. |
| Legal, entity and insurance | Outside clients can't be taken on without contracts, privacy terms and cover. |
| Pricing and billing | The wedge, engagements and platform fees need prices that cover AI and engineering costs. |

---

## Rules that hold the model together
1. **No per-client forks, ever.** Every custom build is configuration (the company layer), a client-private module, or a library module. Forks are what turn consultancies into maintenance traps.
2. **Every module follows the manifest** (Founding doc 2) and every action follows the autonomy policy (Founding doc 3).
3. **Promote what repeats:** a client-private pattern seen across clients moves to the library; an industry concept seen across companies moves to that industry's pack; a concept across industries moves to the core.
4. **Measure the operation, not the model:** time per decision, error rate, volume per operator.

## Build order (revised 14 Oct 2026)
1. **Meetings module with its value report**, used on real meetings (Cody, Bridgette).
2. **Builder kit:** client-private module template, ontology editor, test runner.
3. **Delivery layer:** module versions and channels, staged rollout, rollback, health view.
4. **First paid custom engagement**, ideally the studio.

## Open questions
- Brand: "Agrippa" is used by a US real-estate AI company (agrippa.com). Check trademark registers (IP Australia, USPTO; classes 9, 35, 42) before public launch.
- Pricing for the wedge, engagements and platform fees.
