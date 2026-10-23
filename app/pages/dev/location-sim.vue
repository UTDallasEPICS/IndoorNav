<template>
  <!-- Developer page: runs the location simulator in the browser (no hardware needed).
       Not linked from the app; open /dev/location-sim in the dev server. -->
  <div class="sim-page">
    <h1>Location simulator</h1>
    <p class="note">Sample venue and walk are placeholders (app/utils/location/fixtures).</p>

    <div class="controls">
      <label>
        Estimator
        <select v-model="estimator">
          <option value="leastSquares">Least squares</option>
          <option value="weightedCentroid">Weighted centroid</option>
        </select>
      </label>
      <label>
        RSSI noise (dB)
        <input v-model.number="rssiNoiseDb" type="number" min="0" max="15" step="0.5">
      </label>
      <label>
        Seed
        <input v-model.number="seed" type="number" min="1" step="1">
      </label>
      <button type="button" @click="run">Run</button>
    </div>

    <svg v-if="result" class="plot" :viewBox="viewBox">
      <polygon :points="footprintPoints" class="footprint" />
      <circle v-for="b in sampleVenue.beacons" :key="b.id" :cx="b.enu.e" :cy="-b.enu.n" r="1.2" :class="['beacon', b.floorId]" />
      <polyline :points="truthPoints" class="truth" />
      <circle v-for="(f, i) in result.ble" :key="`b${i}`" :cx="f.enu.e" :cy="-f.enu.n" r="0.5" class="raw" />
      <circle v-for="(f, i) in result.fused" :key="`f${i}`" :cx="f.enu.e" :cy="-f.enu.n" r="0.7" :class="['fused', { indoor: f.isIndoor }]" />
    </svg>
    <p v-if="result" class="legend">
      <span class="key truth-key" /> truth
      <span class="key fused-key" /> fused
      <span class="key raw-key" /> raw BLE
      <span class="key beacon-key" /> beacon (L1 / L2)
    </p>

    <table v-if="result">
      <thead>
        <tr><th /><th>Fused</th><th>Raw BLE</th></tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="row.label">
          <td>{{ row.label }}</td>
          <td>{{ row.format(result.report[row.key]) }}</td>
          <td>{{ row.format(result.bleReport[row.key]) }}</td>
        </tr>
      </tbody>
    </table>

    <ul v-if="result" class="events">
      <li v-for="(e, i) in result.events" :key="i">
        t={{ ((e.timestamp - DEFAULT_SIM.startTime) / 1000).toFixed(1) }} s · {{ describe(e) }}
      </li>
    </ul>
  </div>
</template>

<script setup>
import { computed, onMounted, ref } from 'vue'
import { sampleVenue } from '~/utils/location/fixtures/sampleVenue'
import { sampleWalk } from '~/utils/location/fixtures/sampleWalk'
import { DEFAULT_SIM, runSimulation } from '~/utils/location/sim/simulator'
import { indexVenue } from '~/utils/location/venue'

const estimator = ref('leastSquares')
const rssiNoiseDb = ref(DEFAULT_SIM.rssiNoiseDb)
const seed = ref(1)
const result = ref(null)

const meters = (x) => `${x.toFixed(2)} m`
const percent = (x) => (Number.isNaN(x) ? '–' : `${(x * 100).toFixed(1)}%`)
const rows = [
  { label: 'Fixes', key: 'count', format: String },
  { label: 'Mean error', key: 'meanM', format: meters },
  { label: 'p50 error', key: 'p50M', format: meters },
  { label: 'p90 error', key: 'p90M', format: meters },
  { label: 'Max error', key: 'maxM', format: meters },
  { label: 'Correct floor', key: 'floorCorrectRate', format: percent },
  { label: 'Correct indoor/outdoor', key: 'indoorCorrectRate', format: percent }
]

// SVG y points down, so north is drawn as -n
const viewBox = '85 -95 90 100'
const footprintPoints = indexVenue(sampleVenue).footprints[0].polygon.map((p) => `${p.e},${-p.n}`).join(' ')
const truthPoints = sampleWalk.map((p) => `${p.e},${-p.n}`).join(' ')

async function run() {
  result.value = await runSimulation({
    venue: sampleVenue,
    path: sampleWalk,
    sim: { seed: seed.value, rssiNoiseDb: rssiNoiseDb.value },
    ble: { estimator: estimator.value }
  })
}

function describe(e) {
  switch (e.type) {
    case 'floorChanged': return `floor ${e.from ?? '–'} → ${e.to ?? '–'}`
    case 'buildingEntered': return `entered ${e.buildingId}`
    case 'buildingExited': return `left ${e.buildingId}`
    case 'indoorOutdoorTransition': return e.isIndoor ? 'now indoors' : 'now outdoors'
  }
}

onMounted(run)
</script>

<style scoped>
.sim-page {
  height: 100%;
  overflow-y: auto;
  padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
}

h1 {
  margin: 0 0 4px;
  font-size: 1.3rem;
}

.note {
  margin: 0 0 12px;
  color: var(--color-text-muted);
  font-size: 0.85rem;
}

.controls {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 12px;
  align-items: flex-end;
  margin-bottom: 12px;
}

.controls label {
  display: flex;
  flex-direction: column;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.controls input {
  width: 80px;
}

.controls button {
  padding: 6px 16px;
  border: none;
  border-radius: 8px;
  background: var(--color-primary);
  color: var(--color-on-primary);
  font-weight: 600;
}

.plot {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: 8px;
}

.footprint {
  fill: color-mix(in srgb, var(--color-border) 30%, transparent);
  stroke: var(--color-text-muted);
  stroke-width: 0.3;
}

.beacon.test-l1 { fill: #3b82f6; }
.beacon.test-l2 { fill: #a855f7; }
.truth { fill: none; stroke: var(--color-text); stroke-width: 0.4; stroke-dasharray: 1 0.6; }
.raw { fill: var(--color-error); opacity: 0.35; }
.fused { fill: #7a9a1a; }
.fused.indoor { fill: var(--color-primary); stroke: #7a9a1a; stroke-width: 0.15; }

.legend {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 6px;
  font-size: 0.8rem;
  color: var(--color-text-muted);
}

.key {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-left: 6px;
}

.truth-key { border: 1px dashed var(--color-text); border-radius: 0; height: 0; }
.fused-key { background: var(--color-primary); }
.raw-key { background: var(--color-error); opacity: 0.5; }
.beacon-key { background: linear-gradient(90deg, #3b82f6 50%, #a855f7 50%); }

table {
  width: 100%;
  margin-top: 8px;
  border-collapse: collapse;
  font-size: 0.9rem;
}

th,
td {
  padding: 4px 6px;
  border-bottom: 1px solid var(--color-border);
  text-align: right;
}

th:first-child,
td:first-child {
  text-align: left;
}

.events {
  padding-left: 18px;
  font-size: 0.85rem;
}
</style>
