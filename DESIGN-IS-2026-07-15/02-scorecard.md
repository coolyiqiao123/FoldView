# Dieter Rams scorecard

1. Good design is innovative — Score: 1/3
   Evidence: The opening explicitly ports a familiar Aceternity MacBook-scroll pattern and layers trend-driven aurora/liquid-glass effects, including a WebGL path that cannot mount (`site/index.html:1084`, `1753`, `1960-1999`; `01-evidence.md#visual-evidence`).
   Justification: It imitates current landing-page patterns with minor Foldview-specific variation rather than improving the product-discovery task.

2. Good design makes a product useful — Score: 1/3
   Evidence: The primary value proposition and install action are placed after a 2,160px pinned showcase, followed later by another 180vh reveal, even though the install control itself works (`01-evidence.md#structural-evidence`).
   Justification: The task is supported, but reaching it through the natural page flow requires unnecessary detours.

3. Good design is aesthetic — Score: 1/3
   Evidence: Typography roles and palette direction are coherent, but 39 spacing values, 38 type sizes, 74 referenced colors, and an opening dominated by atmosphere rather than hierarchy create a jarring system violation (`01-evidence.md#visual-evidence`).
   Justification: A recognizable system exists, but the number of exceptions and simultaneous visual layers exceeds the rubric's consistency threshold.

4. Good design makes a product understandable — Score: 1/3
   Evidence: Foldview, `pm`, `folderpreview`, and `project-manager` are not clearly differentiated; jargon and incomplete shortcut claims coexist with a late `h1` and skipped heading levels (`01-evidence.md#copy-and-honesty-evidence`, `#accessibility-evidence`).
   Justification: The primary product can be inferred, but multiple labels and concepts require explanation or correction.

5. Good design is unobtrusive — Score: 0/3
   Evidence: The initial experience is dominated by a 200vh hardware scene, loader, aurora, custom cursor, word reveal, and eight default idle animations (`01-evidence.md#visual-evidence`, `#weight-and-friction-evidence`).
   Justification: Chrome and decoration dominate the content rather than receding behind it.

6. Good design is honest — Score: 1/3
   Evidence: Several supported facts are presented accurately, but the page contains multiple unsupported absolutes, a mislabeled GitHub action, and contradictory menu-bar availability claims (`01-evidence.md#copy-and-honesty-evidence`).
   Justification: More than two inflations and multiple label-to-behavior mismatches rule out a higher score, although no monetization dark pattern exists.

7. Good design is long-lasting — Score: 1/3
   Evidence: Aurora backgrounds, liquid glass, cinematic scroll pinning, custom cursors, and reveal typography strongly mark the page as a specific trend cycle (`site/index.html:184-274`, `655-786`, `1753-1999`).
   Justification: Multiple dated trend markers would make the design age faster than the product's underlying terminal aesthetic.

8. Good design is thorough down to the last detail — Score: 1/3
   Evidence: Loading, success, focus, themes, menu state, responsiveness, and reduced motion are handled, but empty, error, disabled, copy-failure, skip-link, live success, and several contrast/focus cases are missing or rough (`01-evidence.md#visual-evidence`, `#accessibility-evidence`).
   Justification: At least three required states are missing and several implemented states are not accessible end to end.

9. Good design is environmentally friendly — Score: 2/3
   Evidence: Initial JS is 133,359 decoded bytes and motion is gated by reduced-motion, with dark/light themes honored; however eight idle animations and a knowingly ineffective 103,827-byte WebGL import remain (`01-evidence.md#weight-and-friction-evidence`).
   Justification: The build fits the rubric's sub-500KB, motion-gated tier but does not meet the under-100KB/no-idle-animation tier.

10. Good design is as little design as possible — Score: 0/3
   Evidence: Ten sections, 24 repeated-affordance occurrences, two long pinned sequences, and four dead/ineffective implementation units surround a simple explain-and-install task (`01-evidence.md#structural-evidence`).
   Justification: The page is dominated by decoration and duplicated affordances.

Total: **9/30**

