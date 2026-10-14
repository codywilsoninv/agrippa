# Agrippa founding doc 2: Module manifest template

Version 0.1 · 14 Oct 2026 · Status: draft for review

## Purpose
Every module is built to the same template, so any module can be switched on for any company, tested the same way and measured the same way. A module isn't built until its manifest is filled in and the decision section is clear.

## The template

0. **Solves (one sentence, written first):** the problem this module exists to solve, e.g. "Meeting actions get lost because nobody writes them down and follows up." If it can't be said in one sentence, the module isn't ready to build.
1. **Identity:** module id and name, version, status (draft / beta / live), owner.
2. **Decision it serves (fill in first):** the decision in one sentence, in the operator's words; who owns it; the trigger; value (volume per week × cost of getting it wrong or doing it slowly).
3. **Data:** core types read; core types written; industry-pack types used (optional); what the module stores itself and for how long.
4. **Connections:** required capabilities (e.g. "read meeting transcripts"); optional capabilities that unlock extra actions.
5. **Intake:** which kinds of incoming Item it listens for.
6. **Brain:** instructions file and version; hard rules (anything that can be a simple condition); model setting quick / default / complex (the model itself is one config line).
7. **Actions it can propose:** for each, where it runs, default tier, reversible or not, "sent by assistant" label or not. Tiers and limits follow Founding doc 3.
8. **Interface:** screens it adds; assistant tools it adds to the chat bar.
9. **Tests:** where the test set lives, how many examples, the pass bar for releasing a new version.
10. **Metrics (the same three for every module):** time per decision; error rate (denied + edited actions ÷ proposed); volume per operator.
11. **Telemetry it emits:** list of events (Founding doc 4 says what may and may not be included).
12. **Release checklist:**
    - [ ] Solves line written and agreed
    - [ ] Decision section signed off
    - [ ] Reads and writes core types only
    - [ ] Every action has a tier, reversibility and label setting
    - [ ] Tests pass at the pass bar
    - [ ] Telemetry contains no content or names
    - [ ] Used for real by client zero for at least one week

## Worked example: Meeting notes v0.1
| Field | Value |
|---|---|
| Solves | Meeting actions get lost because nobody writes them down, assigns them and follows up. |
| Decision | "What needs doing after this meeting, and by whom?" |
| Decision owner | Meeting organiser |
| Trigger | A new transcript arrives |
| Value | Meetings per week × time spent writing notes and chasing actions |
| Reads | Conversation, Person |
| Writes | Task; summary, decisions and open questions on the Conversation; speaker identities on Person |
| Required connections | Read meeting transcripts (Google Meet via Drive first; manual upload for others) |
| Optional connections | Send email; create calendar event; create task in a task app |
| Hard rules | Never assign a task to an external Person without confirmation. Unknown speakers are asked, never guessed silently. |
| Actions | Create task in Agrippa (approve, reversible). Draft or send follow-up email (approve, irreversible, labelled). Create calendar event (approve, reversible, labelled). |
| Screens | Meetings list; meeting view (points, decisions, actions, transcript with line selection); speaker identification |
| Assistant tools | Edit notes, reassign or re-date actions, approve or deny, summarise or create a task from selected lines |
| Tests | 20 to 30 real transcripts with agreed correct outputs |
| Metrics | Minutes from meeting end to actions approved; deny + edit rate; actions per meeting |
