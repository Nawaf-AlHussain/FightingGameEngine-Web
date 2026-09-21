# FightingGameEngine Web — Frontend 2.1 Redesign & Integration Specification

## 0. Purpose

This specification defines the frontend redesign and integration work for the current `FightingGameEngine-Web` repository.

The goal is **not** to rebuild systems that already exist. The goal is to make the existing engine, progression, asset, settings, input, and mobile systems feel like one coherent application.

The current repository is the source of truth. Before changing behavior, inspect the existing implementation and preserve working engine contracts.

## 1. Critical Instruction

Do not replace or duplicate existing core systems merely to achieve the redesign.

Existing systems that must be preserved and integrated include:

- VS CPU
- VS Player
- Training
- Arcade
- Survival
- Time Attack
- Watch
- Character and stage downloading
- IndexedDB asset caching
- Keyboard remapping
- Touch controls
- Settings/config persistence
- Resolution/display handling
- Progression state
- `/progress`
- `/results`
- Match-result communication
- Mobile/orientation handling
- WASM/IKEMEN integration

The frontend should be redesigned **around these systems**, not recreated beside them.

## 2. Primary Goal

The application should feel like a complete fighting-game frontend from boot to match completion:

Boot → Main Menu → Mode Select → Character Select → Stage Select → Match Preparation → Fight → Result → Progression/Results → Return to Menu.

Every screen should have:

- Clear hierarchy
- Consistent visual language
- Consistent navigation
- Obvious selected/disabled/loading states
- Keyboard support
- Mobile support where applicable
- Real application state rather than fake timers or placeholder state
- Useful error handling

## 3. Global Visual Identity

Use a cohesive fighting-game presentation rather than a collection of unrelated React pages.

Requirements:

- Dark, high-contrast presentation
- Strong arcade/game UI hierarchy
- Large readable headings
- Clear primary/secondary actions
- Consistent panel, card, button, focus, selected, disabled, loading, and error states
- Consistent spacing and typography
- Subtle transitions without delaying interaction
- Avoid unnecessary visual effects that hurt readability or performance

Do not introduce a large UI framework unless the repository already requires it.

## 4. Global Player Colors

Use a consistent visual distinction between Player 1 and Player 2 throughout the frontend.

The distinction should appear in:

- Character selection
- Selected character indicators
- Match preparation
- Versus presentation
- Results
- Relevant progression UI

Do not rely on color alone; labels/icons/text must also communicate the player.

## 5. Global Navigation

Navigation must be predictable.

Requirements:

- Back actions must return to the logically previous screen.
- Cancel must not unexpectedly reset unrelated state.
- Mode changes must clear only state that is no longer applicable.
- Starting a match must preserve the selected configuration required by the match.
- Progression navigation must distinguish between starting a run and continuing a run.
- Browser refresh behavior must not silently corrupt active progression state.

## 6. Boot / Loading

Create one coherent loading experience.

It should:

- Explain what is loading when useful
- Show real progress when real progress information exists
- Avoid fake percentage counters
- Handle WASM initialization failures visibly
- Handle asset initialization failures visibly
- Allow retry where retry is meaningful
- Avoid showing the application as ready before required systems are actually ready

## 7. Main Menu / Lobby

The main menu should be the central entry point.

Expose the currently supported game modes:

- VS CPU
- VS Player
- Training
- Arcade
- Survival
- Time Attack
- Watch
- Settings

The menu must not advertise unsupported functionality as working.

If a mode is unavailable because of a real runtime condition, explain why instead of silently failing.

## 8. Mode Select

Where a separate mode-selection screen is used, each mode should communicate:

- Mode name
- Short description
- Important rules
- Whether it is a single match or progression run
- Required players
- Relevant restrictions

The selected mode must drive the downstream Character Select, Stage Select, Match Preparation, and Result flows.

## 9. Character Select

Character Select is a primary redesign target.

Requirements:

- Clear character grid
- Search/filter support
- Keyboard navigation
- Visible focus
- Strong selected state
- Player 1 / Player 2 ownership
- Character preview
- Loading/download state when applicable
- Cached/ready state when applicable
- Error state when an asset cannot be prepared
- Mobile-friendly selection
- Clear confirmation/cancel actions

Do not hardcode character availability in the UI if the repository already obtains character data dynamically.

## 10. Progression Character Select

Progression modes must integrate with the existing progression state.

For Arcade, Survival, Time Attack, and Watch:

- P1 selection must remain explicit.
- Where the existing implementation automatically generates the opponent, do not force unnecessary P2 selection.
- The UI must clearly explain when the opponent is generated automatically.
- Continuing a run must use the progression state rather than silently starting a new run.
- Character selection must not reset unrelated progression information.

## 11. Character Selection States

At minimum, distinguish:

- Available
- Focused
- Selected by P1
- Selected by P2
- Confirmed
- Downloading
- Preparing
- Ready
- Failed

These states must be represented by actual application state.

Do not use arbitrary timeouts to pretend that a character has become ready.

## 12. Character Preview

The character preview should show useful information already available from the repository.

Potential information includes:

- Name
- Portrait/sprite
- Availability
- Player assignment
- Relevant metadata if actually available

Do not invent character statistics that the engine/data does not provide.

## 13. Character Search

Search must operate on the actual available character list.

Requirements:

- Case-insensitive matching
- Immediate filtering
- Empty-state message
- Keyboard usability
- Mobile usability
- No destructive mutation of the underlying character list

## 14. Stage Select

Stage Select should follow the same interaction model as Character Select.

Requirements:

- Clear stage grid/list
- Search/filter where useful
- Preview
- Focus state
- Selected state
- Download state
- Cached/ready state
- Failure state
- Confirmation gating
- Keyboard navigation
- Mobile navigation

Bundled and downloaded stages must be presented consistently.

## 15. Stage Selection Preview

The selected stage should have a clear preview and name.

Do not claim a stage is ready until the actual asset state says it is ready.

If the current progression implementation uses a default/training stage while continuing through `/progress`, verify that behavior before changing it. If the intended UX is to preserve the originally selected stage across a progression run, implement that as explicit progression state rather than as a UI workaround.

## 16. Download UX

Asset downloads must expose real state:

- Not downloaded
- Queued/preparing
- Downloading
- Verifying/preparing
- Ready
- Failed

Requirements:

- Progress where actual progress is available
- Useful failure message
- Retry
- No false success
- No permanent loading state
- No duplicate downloads when the cache already contains a valid asset
- UI must use the existing download/cache implementation

Do not create a second downloader or second cache.

## 17. Match Preparation

Before entering the fight, show a concise preparation screen.

It should confirm:

- Mode
- P1
- P2/opponent
- Stage
- Relevant mode rules
- Asset readiness
- Start action

Do not make the user wait through unnecessary artificial delays.

## 18. Progression Mode Preparation

Progression modes should show meaningful run context.

For example:

- Arcade: current fight / total fights
- Survival: current win count
- Time Attack: current fight and time rules
- Watch: AI-vs-AI showcase

The information shown must come from the real progression state.

## 19. Fight Screen

The fight screen must prioritize the engine.

Requirements:

- Do not cover gameplay with unnecessary React overlays.
- Preserve existing WASM/IKEMEN input behavior.
- Preserve keyboard and touch behavior.
- Avoid duplicate input bridges.
- Do not change engine behavior without tracing the runtime path.
- Match UI overlays, if any, must be lightweight and removable.

## 20. Match Result Transition

When a match ends:

1. Receive the actual match result.
2. Update the appropriate progression state.
3. Determine whether the run continues or ends.
4. Navigate to the appropriate progress/result presentation.
5. Never infer a win/loss using a frontend timer or unrelated event.

The existing Lua → JS/result communication should be preserved.

## 21. Progress Screen

`/progress` is the continuation screen for active progression.

It should clearly show:

- Mode
- Current fight/progress
- P1
- Current opponent where applicable
- Current stage where applicable
- Relevant rules
- Continue/start-next action
- Exit run action

The user must be able to tell whether they are continuing the current run or starting something new.

## 22. Progress Screen Improvements

Progress presentation should be concise and game-like.

Examples:

- Arcade: Fight 2 / 5
- Survival: 7 Wins
- Time Attack: Fight 2 / 3 and elapsed/remaining time as provided by the actual implementation

Do not fabricate statistics.

## 23. Results Screen

`/results` should summarize completed runs.

Show only data actually available, such as:

- Mode
- Result
- Wins
- Fights completed
- Time where applicable
- Completion/victory state
- Return-to-menu action

Results must not imply persistent online statistics if the repository does not provide them.

## 24. Watch Mode

Watch mode is an AI-vs-AI showcase.

The UI should communicate that:

- Both fighters are controlled by the engine/AI.
- The user is observing rather than directly controlling a fighter.
- A single fight is being presented unless the existing mode implementation says otherwise.

Do not incorrectly present Watch as a normal two-player mode.

## 25. Settings

Settings should be treated as a real application configuration surface.

Integrate with the existing configuration architecture.

Do not create a second configuration store.

Settings should expose only controls that have a verified effect.

## 26. Settings Applicability

Every setting must fall into one of these categories:

- Works immediately
- Works after restart/reload
- Applies to the next match
- Informational/read-only
- Not currently supported

Do not expose controls that appear functional but have no runtime effect.

## 27. Resolution / Display Controls

Resolution and aspect/display controls should have unambiguous labels.

Avoid confusing options that appear equivalent.

The UI should clearly distinguish:

- Internal/game resolution
- Browser/canvas display behavior
- Aspect-ratio behavior

Changes must flow through the existing configuration/runtime path.

## 28. Keyboard Remapping

Keyboard remapping must remain centralized.

Requirements:

- All supported P1/P2 bindings
- Key capture
- Conflict detection
- Invalid-binding feedback
- Clear reset/default action
- Persistence through the existing config mechanism
- Touch controls must use the resulting P1 bindings where the current architecture supports this

Do not create a separate touch-only key mapping.

## 29. Touch Controls

Touch controls must remain integrated with the same input configuration.

Requirements:

- Visibility based on actual touch-device handling
- Correct orientation behavior
- D-pad/button layout suitable for mobile
- P1 remapping reflected in touch controls
- No duplicate keyboard/input architecture
- Clear visual pressed states

## 30. Mobile Character Select

Mobile Character Select should not simply scale the desktop layout down.

Requirements:

- Touch-friendly cards
- Large hit areas
- Search that does not consume excessive space
- Preview panel adapted to narrow screens
- Clear confirmation controls
- No accidental double-selection
- Efficient scrolling

## 31. Mobile Stage Select

Apply the same mobile principles to Stage Select.

Download status, selection state, and confirmation must remain obvious.

## 32. Orientation

Use the existing orientation detection/overlay behavior.

Requirements:

- Landscape-only screens should explain the requirement clearly.
- Do not create a second orientation system.
- Avoid blocking the user unnecessarily on devices that already satisfy the required orientation.

## 33. Error System

Create a consistent error presentation.

Errors should answer:

1. What failed?
2. Why does it matter?
3. Can the user retry?
4. Can the user go back?

Avoid raw stack traces in the normal UI.

Developer diagnostics may remain available through existing debug facilities.

## 34. Loading System

All loading indicators must correspond to actual work.

Do not use arbitrary delays to create the appearance of loading.

Distinguish between:

- Initializing
- Fetching
- Downloading
- Preparing
- Waiting for engine
- Waiting for user confirmation

## 35. Transitions

Use short, consistent transitions.

Transitions must:

- Not hide important state changes
- Not delay gameplay unnecessarily
- Respect reduced-motion preferences where practical
- Not replace actual loading/progress state

## 36. Buttons

Buttons should have consistent:

- Normal
- Hover
- Focus
- Active
- Selected
- Disabled
- Loading
- Error

states.

Primary actions must be visually distinct from secondary/cancel actions.

## 37. Accessibility

Requirements:

- Keyboard navigation
- Visible focus
- Semantic buttons/controls
- Labels for icon-only controls
- Adequate contrast
- No information communicated by color alone
- Reasonable reduced-motion behavior
- Search and selection usable without a mouse

## 38. Responsive Design

Desktop, tablet, and mobile layouts should be deliberate.

Do not simply shrink desktop dimensions.

The important interaction model must remain intact at every supported viewport.

## 39. Performance

Avoid unnecessary re-renders and asset work.

Requirements:

- Do not repeatedly initialize WASM.
- Do not duplicate large asset downloads.
- Use the existing cache.
- Avoid rendering thousands of unnecessary DOM nodes at once where the current asset set makes virtualization useful.
- Keep gameplay isolated from expensive React updates.
- Avoid adding dependencies for problems that can be solved with existing project code.

## 40. Component Architecture

Keep components focused.

Suggested areas include:

- Navigation
- Main menu
- Mode selection
- Character selection
- Stage selection
- Preparation
- Progress
- Results
- Settings
- Mobile controls
- Loading/error states

Do not split components purely for abstraction's sake.

## 41. State Architecture

There should be one authoritative source for each category of state.

Examples:

- Configuration → existing configuration architecture
- Asset availability → existing download/cache architecture
- Active progression → existing progression state
- Match result → existing engine result bridge
- UI state → React/local component state where appropriate

Do not create competing sources of truth.

## 42. Progression State

Progression state must survive navigation within the active run.

It must contain enough information to determine:

- Mode
- P1
- Current opponent
- Current fight
- Win/loss state
- Mode-specific counters
- Selected stage or stage policy
- Time data where applicable

Use the existing progression implementation rather than introducing a parallel state machine.

## 43. Arcade

Required behavior:

- 5 fights
- Random opponents
- Increasing AI difficulty
- A loss ends the run
- Winning all 5 produces a completed/victory result

The UI must reflect the actual progression state.

## 44. Survival

Required behavior:

- Endless opponents
- Loss ends the run
- Win count tracked

The UI must show the current win count without inventing additional statistics.

## 45. Time Attack

Required behavior:

- 3 fights
- 60-second rounds
- Total time tracked
- Loss ends the run

The frontend must not replace the engine's actual timing behavior with a fake timer.

## 46. Watch

Required behavior:

- AI vs AI
- Single fight/showcase behavior as implemented
- User observes rather than controls a fighter

## 47. Current Stage Handling

Stage behavior must be explicit.

If a progression continuation currently falls back to the training/default stage, document that behavior and verify whether it is intentional.

If stage persistence is changed, store the required stage information in the real progression state.

Do not solve this by hardcoding a stage inside a page component.

## 48. Match Preparation and Asset State

A match may start only when required assets are actually ready.

The preparation layer should consume the real readiness state.

Do not replace readiness with:

- fixed delays
- optimistic success
- arbitrary booleans
- duplicated cache checks

## 49. No Fake Technical Information

Never display:

- Fake download percentages
- Fake network status
- Fake ping
- Fake FPS
- Fake engine readiness
- Fake player statistics
- Fake online status
- Fake persistence confirmations

If data is not available, omit it or label the state honestly.

## 50. Browser Compatibility

Preserve compatibility with the browser capabilities already required by the project.

Test important flows in current Chromium-based browsers and verify mobile behavior where applicable.

Do not introduce APIs without checking their support requirements.

## 51. Preserve Existing Engine Contract

The frontend must not casually modify:

- WASM initialization
- IKEMEN runtime behavior
- Input bridge behavior
- Lua result signaling
- VFS behavior
- Asset packaging
- Existing engine configuration semantics

When a UI requirement appears to require an engine change, trace the full runtime path first.

## 52. Code Quality

Requirements:

- Type-safe where the project uses TypeScript
- No dead duplicate architecture
- No unused compatibility code
- No unnecessary dependencies
- No hardcoded data that should come from existing runtime/configuration sources
- Clear naming
- Small, reviewable commits
- Keep documentation synchronized with behavior

## 53. Documentation

Update documentation only after implementation behavior is verified.

Keep the following aligned with the actual repository:

- README
- AGENT.md
- FINDINGS.md
- PROGRESS.md
- TODO.md
- Any frontend-specific documentation

Do not preserve documentation claims that describe an older architecture.

## 54. Implementation Order

Implement in this order:

### Phase 1 — Foundation
- Global visual system
- Navigation
- Shared loading/error states
- Shared button/card/focus states

### Phase 2 — Character Select
- Desktop redesign
- Search
- Preview
- Selection states
- Progression-specific selection behavior
- Mobile layout

### Phase 3 — Stage Select
- Desktop redesign
- Preview
- Download/cache states
- Confirmation
- Mobile layout

### Phase 4 — Match Preparation
- Match summary
- Asset readiness
- Mode-specific information
- Clean transition into engine

### Phase 5 — Progression
- Arcade
- Survival
- Time Attack
- Watch
- `/progress`
- Progression navigation

### Phase 6 — Results
- `/results`
- Run summaries
- Correct end-state navigation

### Phase 7 — Settings
- Visual redesign
- Configuration integration
- Keyboard remapping
- Display controls
- Honest unsupported-state handling

### Phase 8 — Mobile
- Touch controls
- Orientation
- Mobile character/stage selection
- Responsive navigation

### Phase 9 — Polish
- Transitions
- Accessibility
- Performance
- Error states
- Documentation

## 55. What NOT To Do

Do not:

- Rebuild WASM.
- Replace the progression state machine.
- Create another configuration store.
- Create another download cache.
- Hardcode character/stage lists when the repository already provides them.
- Create separate touch key mappings.
- Remove working game modes.
- Pretend unsupported settings work.
- Add fake online/network/statistics features.
- Replace real asset state with timers.
- Add unnecessary dependencies.
- Rewrite the entire application merely for visual reasons.
- Change engine behavior without tracing the runtime.
- Introduce duplicate input bridges.
- Hide failures behind optimistic UI.

## 56. Definition of Done

The redesign is complete when:

- Boot has a coherent loading/error experience.
- Main Menu exposes all currently supported modes.
- Mode selection is clear.
- Character Select works with mouse, keyboard, and supported touch layouts.
- Character search works against the real character list.
- Stage Select works with bundled and downloaded assets.
- Download failures are visible and retryable.
- Match Preparation reflects actual readiness.
- VS CPU works.
- VS Player works.
- Training works.
- Arcade completes its real progression.
- Survival tracks its real progression.
- Time Attack follows its real rules.
- Watch works as an AI-vs-AI mode.
- Match results lead to the correct continuation/end screen.
- `/progress` accurately represents active runs.
- `/results` accurately represents completed runs.
- Settings persist through the existing configuration architecture.
- Keyboard remapping works and detects conflicts.
- Touch controls follow the configured P1 bindings where supported.
- Resolution/display controls are clearly labeled and functional according to the actual runtime.
- Mobile/orientation behavior works.
- Errors are understandable.
- Loading states represent real work.
- No fake technical information is presented.
- No duplicate core architecture has been introduced.
- Documentation matches the implemented behavior.

## 57. Final User Journey

The intended experience is:

1. Boot the application.
2. See a clear loading state.
3. Arrive at the main menu.
4. Choose a mode.
5. Select a character.
6. Select a stage where applicable.
7. See match preparation.
8. Start the real IKEMEN/WASM fight.
9. Receive the real match result.
10. Continue the progression when appropriate.
11. See a meaningful progress or results screen.
12. Return to the main menu without losing unrelated configuration.
13. On mobile, perform the same flow with touch and correct orientation behavior.

## 58. Agent Execution Rule

Treat this document as an implementation specification, not a request to redesign the architecture.

Before editing:

1. Inspect the current implementation.
2. Identify the existing source of truth for the feature.
3. Reuse it.
4. Make the smallest architectural change necessary.
5. Verify the actual runtime behavior.
6. Update documentation after verification.

When uncertain, prefer tracing the current implementation over inventing a new system.
