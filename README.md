Use type script -strict
Ttile: " Eftelaing-dust"
create a singel html with typescript in it, or choose to go evetual public via gihub.io ,(use cli gh commadn)  ;; it simulaties a combined model it combines osi-layers repersntatin and in apaprpallelala the maslov pyramid . the the  osi-layer;plus (7+3 Lyers) should ahve a detaild svg maxgraph diagram , and also the Maslov pyramid is drawn with maxgraph  , I wanto see them sisde by side and i wanbt realtime (webgpu?) simulations give the simulation buutons speed sliders options go prifessianl her at lest 5 impeortt realtime use-gui-elements and fire button help every with popup, man do the works 

Now the new part we put layer 8 9 and 10 on top of leaery osi 7 ; to start we use osi layer 9 as the users conscienness stuff , feeling paoin deligth interest duriosity, exactatic plesure ;; lower OSI-layers doe stabilizaiton of the lauer abaove form 0 to 10 ;; ot feels loke a music instrument too , the instrument>the paleryres> the director , and back the driecter > palyers> instrument os all perftaly amable with a combination of masnlsopyramid an the OSOplus mode ; Moer intuition from me the dev-archetect to layers contain a nD-rippletank where it can  do comples wave simetalirn , the coupleing between osi-layers-nDwaves is a field to experiment with (create clickable  scenarioos) all realtiem  

Mark diagram (slectabl view ) with appriate lables >>   psycholigial, psychiatric adn nerve-cell-bialogie 

Code Librarie suggestions draw.io of maxgraph preferablu via mcp 

Pleas implement the following 
dev-sources : 
Source #1 (Ubiquitous Elementary Consciousness): Dust (His Dark Materials) – Wikipedia

Source #2 (Neural Context & Neuromodulation): Psychedelics align brain activity with context – Nature

---

## Implementation notes (v2)

Live: https://springyworks.github.io/eftelaing-dust/ (built with `npm run build`, copied to `docs/index.html`).

- **Dust enters at L10** (the Director) only. It reaches the lower layers solely through the top-down coupling slider.
- **Maslow x OSI+ matrix** (maxGraph): Maslow levels are rows, OSI+ layers are columns. Views: activity (OSI+ to Maslow), unmet need (Maslow to OSI+) and the editable mapping weights. Click a cell to cycle its weight (0, 0.5, 1), a column header to strike a layer, a row header to strike every layer mapped to that level. The "Maslow to OSI+ drive" slider lets unmet needs excite quiet layers (reverse mapping).
- **Wave-tank monitor** (replaces the earlier decorative instrument): every layer is an FM voice driven by measurements of its tank. Pitch = measured frequency, level = rms, FM index = peakiness (crest factor) and phase-lock with neighbours, plus spike detection (sudden velocity jumps) with LEDs, counters, a bright FM pluck and a live spectrum. Pitch is a fixed time-scaling (1600 Hz per rad/step), so it shows relative, not physical, frequencies.
- Artistic simulation, not a validated neuroscience model.

## Implementation notes (v3)

- **Monte Carlo auto-exerciser** (`src/exerciser.ts`, `src/taste.ts`): it glides the sliders to random proposals, lets you listen, then pops up a dialog with **No / Maybe / Yes** (keys `B` `N` `M` `Y`, optional stronger `L` Hellish and `H` Heavenly). Optional "what is off?" chips (too flat / too wild dynamics, dull / harsh voices, stiff / messy rhythm) steer the next proposal by nudging the sliders they name; Boring also raises exploration. Starting it switches the sound on. A Gaussian-process model learns your taste from the ratings (Hellish=-0.5, No=0, Boring=0.25, Maybe=0.5, Yes=1, Heavenly=1.5) and proposes new settings (local moves, moves around favourites, global jumps) by predicted liking plus an exploration bonus. The taste profile shows per-slider relevance, click a row to lock a slider. "Play my favourite" jumps to the best known setting, "Forget everything" resets. Ratings persist in `localStorage`. `speed` and `volume` are never auto-moved.
- **Sand bed** (`src/sim.ts`): every tank has a sand bed that changes the local wave speed (shallow = slow). Waves erode: sand moves from energetic cells to quiet cells (Chladni / streaming), and gravity levels it out again. Transport is face-to-face flux, so **sand mass is conserved exactly**, it only redistributes. Sliders: erosion, levelling, sand depth effect. Buttons: "Level the sand", "Seed random dunes". Scenario "Sea builds a beach" shows it.
- **Projections** (`src/render.ts`): wave, sand relief, sand + water, isometric and beach profile.
- **Stereo / HRTF jazz** (`src/audio.ts`): each layer is a source placed in a binaural scene (azimuth from layer and tank centroid, elevation by layer, distance by lock). Parametric HRTF after `knowlege_source/Hearing.md`: Woodworth ITD, head-shadow shelf, pinna notches, back shelf, air absorption, synthetic room reverb. Alternative modes: plain stereo pan, mono. Pitches snap to a Dm11 | G13 | Cmaj9#11 | A7b9b13 loop (92 bpm) with swing. The scene card shows the cues. Use headphones.
- **Jazz band played by the whole brain** (`src/band.ts`): layer 1 (Physical) is the rhythm section: its tank drives the walking bass, ride and the comping activity. With *Brain plays the band* up, the other layers join: L4 sets the comping peakiness, L7/L8 steer the melody, L10 (Director) conducts the tempo, and every Maslow level feeds the harmony (low fulfilment = tense Cmaj9#11 / A7b9b13, high = resolved Cmaj9 / A13). Brain health (alignment + stability) decides how tight and in tune it plays; Dust loosens the timing; spikes and FIRE add accents. The **layer choir** gives L2 to L10 one MIDI voice each (chord tones from the pitch the tank measures, louder when it spikes). Every voice, the band's four instruments and the ten choir voices, is its own binaural source with the HRTF cues of `knowlege_source/Hearing.md` (ITD, head shadow, pinna notch, room), at its place in the scene card.
- **The brain learns to play**: bass, keys, lead, ride, choir level and brain share are ordinary sliders, so the Monte Carlo exerciser explores them and learns from your No / Maybe / Yes / Heavenly answers what band you like.
- **General audio settings** (collapsed group in the sidebar): *Audio mode* has three listening options: **1. Raw FM synthesiser** (the original nervous audification of all ten layers, for inspecting the system), **2. Internal music** (the whole brain plays the MIDI band), **3. Layer 1 alone plays the synthesiser**; plus Raw + music together. Sliders: raw FM level, band level, band busyness, brain share, choir level, bass / keys / lead / ride levels and tempo (explored by the Monte Carlo exerciser, except the two master levels and volume, which you own). *MIDI output* optionally sends the band to the first Web MIDI port (bass ch 1, keys ch 2, lead ch 3, choir ch 4-9 and 11-13, drums ch 10).
- "rfti" in the original request was read as HRTF.

## Genre: dust-programming (crap-art)

A proposed software-development category: start from a serious play-tool and "clay ourselves into the future". Keywords so far: **dust-programming**, **crap-art**, **playtool**, **pseudo-science**, **art for everyone**, **serious self-insight**. It is openly pseudo-science: the models are metaphors you can poke, hear and rewire (matrix mapping, FM audification), not validated theory. Add more keywords here.
