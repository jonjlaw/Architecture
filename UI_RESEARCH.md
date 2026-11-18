# What makes a good interface for Faultline

Research done on 2026-11-17 before redesigning the interface in `index.html`. It records the criteria the redesign was held to, where each came from, what was changed to meet it, and what is still open.

Faultline is three kinds of tool at once, so the research drew on three bodies of practice:

- a **node-link diagram editor** (palette, canvas, inspector);
- an **observability view** of a running system (service map, health, dashboards);
- a **simulation used for learning and experiments** (explorable explanations, chaos engineering).

## How far to trust each source

Two sources were read in full: the NN/g article on complex applications and Bret Victor's "Up and Down the Ladder of Abstraction". Everything else comes from search-result summaries of the pages listed, which is enough to establish the principle but not exact wording or thresholds. Check the original before quoting any of them.

Gaps the searches did not fill:

- No formal standard exists for node-editor visual design; the evidence is vendor documentation and practitioner write-ups that happen to agree.
- No UX research on service-map design turned up, only product documentation (Kiali, Vizceral).
- Nothing on how Gremlin or AWS FIS present experiments in their consoles.
- Carbon's definitions for medium- and low-attention indicators were cut off in the results.

## Criteria

### 1. Say what users experience first, causes second

Grafana's guidance is to judge a system by its symptoms: the RED signals (rate, errors, duration) describe how happy users are, while resource metrics describe how happy machines are. Alerts belong on symptoms. A dashboard should answer one question and progress from general to specific. The Golden Signals add saturation to RED.

**In Faultline:** a status strip under the toolbar gives a verdict (Healthy, Degraded, Failing, Recovering) computed from the last 3 seconds of client results, never from the faults themselves. Every component shows the same line in the same order: rate in, error share, p99, with a saturation bar along the bottom.

### 2. Never rely on colour alone

WCAG 1.4.1 forbids colour as the only carrier of information; 1.4.11 requires 3:1 contrast for meaningful graphics, which includes status indicators and meter fills. Carbon's status-indicator pattern combines shape, colour and symbol, and grades indicators by how much attention they demand.

**In Faultline:** status is a shape as well as a colour (● healthy, ▲ degraded, ■ down, ○ idle), repeated as a word in tooltips and in the inspector. A Legend on the canvas explains shapes, line styles and dots, as Kiali's does.

### 3. Overview first, zoom and filter, then details on demand

Shneiderman's mantra, from "The Eyes Have It" (1996). Its seven tasks are overview, zoom, filter, details-on-demand, relate, history and extract.

**In Faultline:** zoomed out, a component shows only its name and status. Rates appear at normal zoom. Connection settings appear when zoomed in, hovered or selected. Selecting a component highlights its connections (the "relate" task).

### 4. Reduce clutter without reducing capability

From NN/g's eight guidelines for complex applications (Kaplan, 2020). The ones that applied most:

- **Reduce clutter without reducing capability**: use staged disclosure, showing advanced options only when relevant.
- **Make important information visually salient**: removing nonessential elements makes key data stand out as much as adding colour or weight.
- **Ease the transition between primary and secondary information**: let users see supporting detail without leaving the screen.
- **Promote learning by doing**: show live results as users build.
- **Help users track actions and thought processes**: users lose their place during interruptions.
- **Provide flexible and fluid pathways**: avoid rigid linear flows.

The remaining two are "help users adopt more efficient methods" and "coordinate transitions among tools and workspaces".

**In Faultline:** New, Save, Export and Import moved into a File menu. Clock controls are grouped. Healthy components are visually quiet so unhealthy ones stand out. Inspector sections remember whether they were opened or closed. The Guided / All options split already in place is staged disclosure and was kept.

### 5. An experiment has a baseline, a fault window and a result

Chaos-engineering practice defines a steady-state hypothesis as a measurable baseline taken before the fault ("when X fails, metric Y stays within Z"), then checks it during and after. One open-source experiment dashboard summarises a run as hypothesis, blast radius, recovery time and a verdict.

**In Faultline:** the Dashboard has an experiment report. It starts when a scenario is applied or the first fault is injected, and compares before, during and after: client success, failed requests, peak latency and backlog, time to recover, and the consistency anomalies that healing did not undo. The fault window is shaded on the charts.

### 6. Every aggregate should lead to a concrete case

Bret Victor's "Ladder of Abstraction": understanding comes from moving between a concrete instance and the aggregate pattern, so every abstraction needs a way back down. Real-time playback alone is a poor way to understand a system. Give direct control of time (play, pause, scrub, jump between events), and also show the whole trajectory as a static picture.

Victor's explorable-explanations work adds that an explorable must guide attention to particular phenomena; dropping the user into a sandbox is not an explanation.

**In Faultline:** in the audit, an underlined count lists the requests behind it, and the selected request's path is outlined on the canvas. Charts show the run as a trajectory with fault and heal marks. The guided checklist and the scenario cards direct attention.

### 7. Keep system state visible at all times

Kiali colours edges by request health and offers traffic animation as an option. Netflix's Vizceral was built on the idea that a well-drawn traffic view lets people grasp system state at a gut level, without parsing numbers.

**In Faultline:** active faults are listed in the status strip as chips (click to jump to the target, ✕ to clear that one). Connections turn amber above 2% failures and red above 30% in both the Messages and Flow views.

### 8. Follow the conventions of diagram editors

Vendor documentation and write-ups agree on a palette on the left, canvas in the centre, and an inspector on the right that shows system-level content when nothing is selected. Also common: undo, drop-into-group, a clear direction of flow, minimal chrome.

**In Faultline:** already the case, so the layout was kept. Components can now be reached with Tab and opened with Enter.

## Not done

- **Time scrubbing** (criterion 6). The engine cannot step backwards, so rewinding and replaying needs an engine change: either periodic state snapshots or a deterministic replay from the seed.
- **Light theme.** The app is dark only.
- **Snapping and alignment guides**, recommended by several diagram-library checklists.
- **A command palette** for adding and finding components.
- **Hysteresis on status.** Alerting guidance recommends separate thresholds for entering and leaving a state. Status here uses one threshold over a short window, so a component near 2% errors can flicker between healthy and degraded.

## Sources

Read in full:

- [NN/g: 8 design guidelines for complex applications](https://www.nngroup.com/articles/complex-application-design/)
- [Bret Victor: Up and Down the Ladder of Abstraction](https://worrydream.com/LadderOfAbstraction/)

From search summaries:

- [Shneiderman: The Eyes Have It](https://www.cs.umd.edu/users/ben/papers/Shneiderman1997next.pdf)
- [Grafana dashboard best practices](https://grafana.com/docs/grafana/latest/dashboards/build-dashboards/best-practices/)
- [Kiali topology graph](https://v2-24.kiali.io/docs/features/topology)
- [WCAG: Understanding non-text contrast](https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast)
- [Carbon status indicator pattern](https://carbondesignsystem.com/patterns/status-indicator-pattern)
- [PatternFly: status and severity](https://patternfly.org/patterns/status-and-severity)
- [Netflix Vizceral](https://github.com/Netflix/vizceral)
- [Bret Victor: Explorable Explanations](https://worrydream.com/ExplorableExplanations/)
- [Bret Victor: Learnable Programming](https://worrydream.com/LearnableProgramming)
- [Operator chaos dashboard guide](https://ugiordan.github.io/operator-chaos/guides/dashboard-operator/)
- [JointJS: BPMN modeler UI feature checklist](https://www.jointjs.com/blog/bpmn-modeler-ui-feature-checklist)
- [ArchTect UI reference](https://nicobit.github.io/ArchTect/user-guide/ui-layout/)
