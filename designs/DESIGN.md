# Signal-A Studio • Award–Winning Web Design & Product Design Studio

## Overview

**Product:** Signal-A Studio • Award–Winning Web Design & Product Design Studio
**URL:** https://signal-a.studio/
**Surface type:** e-commerce
**Audience:** Consumers and shoppers
**Brand character:** Product-focused shopping experience with a minimal, restrained color palette and 3 typefaces.

### Design Principles

- Trust signals first — credibility reduces friction more than clever copy.
- Clear path to action — one primary CTA per view, never stacked.
- Speed over polish — perceived performance is part of the design system.

## Colors

| Token | Value | Role |
|-------|-------|------|
| color-2 | `#FFFFFF` | Background |
| color-1 | `#000000` | Text Primary |

## Typography

**Font stack:** Gt America Mono, Neue Haas Grotesk Text Pro, sans-serif

| Level | Size | Usage |
|-------|------|-------|
| text-xs | 13px | Captions, metadata |
| text-sm | 16px | Labels, secondary text |
| text-base | 19px | Body text (default) |
| text-lg | 23px | Subheadings, emphasis |

**Weight scale:** 300 · 400
**Line heights:** 12px · 23px · 19px · 13px · 18.2px

## Spacing

**Base unit:** 4px

`space-1: 1px` · `space-2: 5px` · `space-3: 8px` · `space-4: 10px` · `space-5: 15px` · `space-6: 20px` · `space-7: 25px` · `space-8: 30px` · `space-9: 40px` · `space-10: 60px` · `space-11: 100px` · `space-12: 140px` · `space-13: 593px`

## Shapes

**Border radius:** `radius-sm: 1px` · `radius-md: 10px`

## Elevation

_None detected._

## Motion

- **duration-fast:** `all`
- **duration-fast:** `none`

## Components

- **Links:** 43 detected
- **Images:** 54 detected

## Do's and Don'ts

### Do

- Reference tokens by name, not raw values — agents and developers should use `color.text.primary`, not `#171717`.
- Define all interactive states: default, hover, focus-visible, active, disabled.
- Use the spacing scale for all padding, margin, and gap values.
- Write content in sentence case. Reserve ALL CAPS for acronyms only.
- Test every component at the smallest and largest breakpoint before shipping.

### Don't

- Do not introduce colors outside the extracted palette.
- Do not use arbitrary spacing values — stick to the scale.
- Do not mix border-radius values. Pin to the detected set (1px, 10px).
- Do not stack more than one primary CTA per viewport.
- Do not use red for non-error UI — reserve it for destructive actions and warnings.
- Do not ship components without defining hover, focus-visible, and disabled states.

## Writing Tone

Persuasive, benefit-driven, trustworthy. Active voice, urgency without pressure.

## Authoring Workflow

When creating or updating a component guideline for this system, follow this sequence:

1. **State the intent** — one sentence on what the component does and why it exists.
2. **Map tokens** — list every color, spacing, typography, and radius token the component uses. No raw values.
3. **Define anatomy** — break the component into named parts (container, label, icon, etc.) with their token assignments.
4. **Specify states** — document every state: default, hover, focus-visible, active, disabled, loading, error, empty.
5. **Describe interactions** — keyboard, pointer, and touch behavior, including edge cases (long content, overflow, truncation).
6. **Add accessibility criteria** — write testable pass/fail checks (e.g. "focus ring must be visible at 3:1 contrast").
7. **List anti-patterns** — concrete examples of misuse with a brief explanation of why each is wrong.
8. **Close with a QA checklist** — a mechanical list of verifiable items (see Definition of Done below).

## Required Output Structure

Every component guideline produced from this system must contain these sections, in order:

1. Overview — purpose, when to use, when not to use.
2. Tokens and foundations — all referenced tokens from the tables above.
3. Anatomy and variants — named parts, variant matrix, responsive behavior.
4. States and interactions — full state table, keyboard/pointer/touch behavior.
5. Accessibility — ARIA attributes, contrast requirements, focus management, screen reader behavior.
6. Content guidelines — copy length, tone, capitalisation, placeholder text rules.
7. Anti-patterns — explicit examples of what not to build, with reasoning.

## Component Requirements

Every component built against this system must:

- Reference only tokens defined in the tables above — no hardcoded hex, px, or font values.
- Define all interactive states: default, hover, focus-visible, active, disabled, loading, error.
- Specify responsive behavior at the smallest and largest supported breakpoint.
- Handle edge cases: empty state, overflow / truncation, maximum content length.
- Include keyboard navigation (Tab, Enter, Escape, Arrow keys where applicable).
- Document ARIA roles, labels, and live-region behavior where relevant.
- Include known page component density: - **Links:** 43 detected
- **Images:** 54 detected

## Definition of Done

A component is not complete until every item below is checked:

- Renders correctly in its default state (smoke test).
- All states documented and visually verified (hover, focus, disabled, loading, error, empty).
- All visual values use design tokens — zero hardcoded values.
- Keyboard navigation works without a pointer.
- No critical accessibility violations (contrast, ARIA, focus order).
- Tested at smallest and largest breakpoint.
- Anti-patterns section lists at least one concrete misuse example.
- Documentation covers purpose, usage, props/API, and limitations.
