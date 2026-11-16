# Upgrade scene

Outcome: the same scene, measurably closer to the quality bar, with the user's intent intact.

1. Copy the scene file. Work on the copy.
2. Run `render-qa` on the original. Score it on the rubric. Keep these screenshots as the before set.
3. Name the three weakest rubric rows and the stage skill that owns each: silhouette (`mesh-texture-upscale`), materials (`pbr-lookdev`), lighting (`lighting-ibl-shadows`, `raytracing-light-transport`), grounding (`lighting-ibl-shadows`), exposure and colour (`post-processing-stack`), artifacts and edges (`antialiasing-resolution`), performance (`performance-budget`).
4. Fix in dependency order, geometry then surface then light then post then motion. Change one parameter family per run and re-run `render-qa` after each stage.
5. Stop after 3 full QA loops. Report what is left.
6. Dispatch `3d-render-critic` for the verdict. It must not be the agent that made the changes.

Reply: before and after screenshots side by side, the numbers that moved, and any change you made that the user did not ask for.
