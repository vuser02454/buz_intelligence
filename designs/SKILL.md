---
name: design-system-signal-a-studio-award-winning-web-design-product-design-studio
description: >
  Apply the Signal-A Studio • Award–Winning Web Design & Product Design Studio design system when building or updating UI.
  Use when creating components, choosing colors or typography,
  or reviewing designs for e-commerce interfaces.
---

# Signal-A Studio • Award–Winning Web Design & Product Design Studio — Design System Skill

## When to Use

- Building new UI components for Signal-A Studio • Award–Winning Web Design & Product Design Studio.
- Reviewing or updating existing component styles.
- Choosing colors, typography, or spacing for e-commerce pages.
- Checking designs against the extracted token set.

## Context

- **Product:** Signal-A Studio • Award–Winning Web Design & Product Design Studio — https://signal-a.studio/
- **Surface:** e-commerce
- **Audience:** Consumers and shoppers
- **Character:** Product-focused shopping experience with a minimal, restrained color palette and 3 typefaces.

## Tokens

### Colors

| Token | Value | Role |
|-------|-------|------|
| color-2 | `#FFFFFF` | Background |
| color-1 | `#000000` | Text Primary |

### Typography

**Font stack:** Gt America Mono, Neue Haas Grotesk Text Pro, sans-serif

| Level | Size | Usage |
|-------|------|-------|
| text-xs | 13px | Captions, metadata |
| text-sm | 16px | Labels, secondary text |
| text-base | 19px | Body text (default) |
| text-lg | 23px | Subheadings, emphasis |

**Weight scale:** 300 · 400
**Line heights:** 12px · 23px · 19px · 13px · 18.2px

### Spacing

**Base unit:** 4px

`space-1: 1px` · `space-2: 5px` · `space-3: 8px` · `space-4: 10px` · `space-5: 15px` · `space-6: 20px` · `space-7: 25px` · `space-8: 30px` · `space-9: 40px` · `space-10: 60px` · `space-11: 100px` · `space-12: 140px` · `space-13: 593px`

### Shapes

**Border radius:** `radius-sm: 1px` · `radius-md: 10px`

### Elevation

_None detected._

### Motion

- **duration-fast:** `all`
- **duration-fast:** `none`

## Component Inventory

- **Links:** 43 detected
- **Images:** 54 detected

## Constraints

### Always

- Use tokens from the tables above — do not introduce new values.
- Include hover, focus-visible, and disabled states for interactive elements.
- Follow the 4px spacing grid.
- Meet WCAG 2.2 AA contrast minimums.

### Never

- Do not introduce colors outside the extracted palette.
- Do not use arbitrary spacing values — stick to the scale.
- Do not mix border-radius values. Pin to the detected set (1px, 10px).
- Do not stack more than one primary CTA per viewport.
- Do not use red for non-error UI — reserve it for destructive actions and warnings.
- Do not ship components without defining hover, focus-visible, and disabled states.

## Tone

Persuasive, benefit-driven, trustworthy. Active voice, urgency without pressure.

## Authoring Workflow

When creating or documenting a component for this system:

1. State intent — one sentence on purpose.
2. Map tokens — list every token the component uses.
3. Define anatomy — named parts with token assignments.
4. Specify states — default, hover, focus-visible, active, disabled, loading, error, empty.
5. Describe interactions — keyboard, pointer, touch, edge cases.
6. Add a11y criteria — testable pass/fail checks.
7. List anti-patterns — concrete misuse examples.
8. Close with the Definition of Done checklist.

## Output Structure

Component guidelines must contain, in order:

1. Overview (purpose, when to use, when not to use)
2. Tokens and foundations
3. Anatomy, variants, responsive behavior
4. States and interactions
5. Accessibility (ARIA, contrast, focus, screen reader)
6. Content guidelines (copy rules, tone)
7. Anti-patterns with reasoning

## Component Requirements

- Reference only tokens from the tables above.
- Define all states: default, hover, focus-visible, active, disabled, loading, error.
- Handle edge cases: empty, overflow, truncation, max content.
- Include keyboard navigation behavior.
- Document ARIA roles and labels.

## Definition of Done

- Default state renders (smoke test).
- All states visually verified.
- Zero hardcoded visual values — tokens only.
- Keyboard navigation works without pointer.
- No critical a11y violations.
- Tested at min and max breakpoint.
- At least one anti-pattern documented.
- Purpose, usage, and limitations documented.
