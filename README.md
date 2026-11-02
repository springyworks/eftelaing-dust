Use type script -strict
Ttile: " Eftelaing-dust"
create a singel html with typescript in it, or choose to go evetual public via gihub.io ,(use cli gh commadn)  ;; it simulaties a combined model it combines osi-layers repersntatin and in apaprpallelala the maslov pyramid . the the  osi-layer;plus (7+3 Lyers) should ahve a detaild svg maxgraph diagram , and also the Maslov pyramid is drawn with maxgraph  , I wanto see them sisde by side and i wanbt realtime (webgpu?) simulations give the simulation buutons speed sliders options go prifessianl her at lest 5 impeortt realtime use-gui-elements and fire button help every with popup, man do the works 

Now the new part we put layer 8 9 and 10 on top of leaery osi 7 ; to start we use osi layer 9 as the users conscienness stuff , feeling paoin deligth interest duriosity, exactatic plesure ;; lower OSI-layers doe stabilizaiton of the lauer abaove form 0 to 10 ;; ot feels loke a music instrument too , the instrument>the paleryres> the director , and back the driecter > palyers> instrument os all perftaly amable with a combination of masnlsopyramid an the OSOplus mode ; Moer intuition from me the dev-archetect to layers contain a nD-rippletank where it can  do comples wave simetalirn , the coupleing between osi-layers-nDwaves is a field to experiment with (create clickable  scenarioos) all realtiem  



Code Librarie suggestions draw.io of masxgraph preferablu via mcp 

Pleas implement the following 
dev-sources : 
Source #1 (Ubiquitous Elementary Consciousness): Dust (His Dark Materials) – Wikipedia

Source #2 (Neural Context & Neuromodulation): Psychedelics align brain activity with context – Nature

---

# Implementation notes

Single-file app: TypeScript (`strict`) + maxGraph, bundled by esbuild into `dist/index.html` (no server needed, just open it).

```bash
npm install
npm run build        # typecheck + dist/index.html
```

Publish later via GitHub Pages (not done yet):

```bash
git init -b main && mkdir -p docs && cp dist/index.html docs/index.html
git add -A && git commit -m "Eftelaing-dust"
gh repo create eftelaing-dust --public --source=. --push
gh api -X POST repos/:owner/eftelaing-dust/pages -f "source[branch]=main" -f "source[path]=/docs"
```

## Model
- 10 layers (OSI 1-7 = Instrument, L8 Player, L9 Consciousness, L10 Director), each a 1D/2D/3D damped wave medium (`src/sim.ts`).
- Neighbouring layers are coupled (bottom-up / top-down sliders). Layer N-1 stabilises layer N through extra damping and a restoring force; a loud layer lowers the stability chain above it.
- Maslow levels (6, bottom-up) are each fed by 1-2 layers: fulfilment = layer vitality x stability from below; unmet lower levels fade the ones above.
- L9 feelings: pain, delight, interest, curiosity, ecstatic pleasure, each a distinct emitter pattern.
- Source #1 (Dust): background random excitation of every cell of every layer.
- Source #2 (Nature, psychedelics): dose loosens stabilisation, raises inter-layer coupling and pulls every layer toward a context field (rest / meditation / music / movie); the context alignment index is shown live.
- Sound: ten voices on a stacked pentatonic ladder, level = layer amplitude; pain detunes L9, director intent adds tremolo.
- Solver runs on the CPU (Float32Array); WebGPU is only detected and reported.
