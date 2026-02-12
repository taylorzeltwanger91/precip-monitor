import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { initializeApp } from 'firebase/app'
import { getFirestore, collection, getDocs, addDoc, updateDoc, deleteDoc, doc, Timestamp } from 'firebase/firestore'
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png'
import markerIcon from 'leaflet/dist/images/marker-icon.png'
import markerShadow from 'leaflet/dist/images/marker-shadow.png'

// ── Leaflet icon fix ──
delete L.Icon.Default.prototype._getIconUrl
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow,
})

// ── Firebase config ──
// Create a Firebase project at https://console.firebase.google.com
// Enable Firestore, then paste your config below
const firebaseConfig = {
  apiKey: "AIzaSyCPDpq0yoJCHvBq0B6HnD0kuUbhj7VkL5w",
  authDomain: "weather-data-1500d.firebaseapp.com",
  projectId: "weather-data-1500d",
  storageBucket: "weather-data-1500d.firebasestorage.app",
  messagingSenderId: "748503042116",
  appId: "1:748503042116:web:587b3aec413a782d6e9411",
}

const app = initializeApp(firebaseConfig)
const db = getFirestore(app)

// ── Constants ──
const MM_TO_INCHES = 0.0393701
const REFRESH_INTERVAL = 60 * 60 * 1000 // 1 hour
const FETCH_DELAY = 100 // ms between API calls
const PRECIP_THRESHOLDS = { light: 0, moderate: 0.25, heavy: 0.5 }

function getPrecipClass(precip) {
  if (precip >= PRECIP_THRESHOLDS.heavy) return 'heavy'
  if (precip >= PRECIP_THRESHOLDS.moderate) return 'moderate'
  if (precip > PRECIP_THRESHOLDS.light) return 'has-rain'
  return ''
}

function getPrecipColor(cls) {
  if (cls === 'heavy') return '#1d4ed8'
  if (cls === 'moderate') return '#2563eb'
  if (cls === 'has-rain') return '#60a5fa'
  return '#6b7280'
}

// ── Firestore helpers ──
async function loadSites() {
  const snapshot = await getDocs(collection(db, 'sites'))
  return snapshot.docs.map(d => ({ id: d.id, ...d.data() }))
}

async function addSiteDoc(site) {
  const ref = await addDoc(collection(db, 'sites'), site)
  return { id: ref.id, ...site }
}

async function updateSiteDoc(id, data) {
  await updateDoc(doc(db, 'sites', id), data)
}

async function deleteSiteDoc(id) {
  await deleteDoc(doc(db, 'sites', id))
}

// ── Weather fetch ──
const WEATHER_PARAMS = 'precipitation,temperature_2m,relative_humidity_2m,dew_point_2m,wind_speed_10m,wind_direction_10m'

function celsiusToFahrenheit(c) { return c != null ? Math.round((c * 9 / 5 + 32) * 10) / 10 : null }
function kphToMph(k) { return k != null ? Math.round(k * 0.621371 * 10) / 10 : null }
function lastVal(arr) { return arr && arr.length > 0 ? arr[arr.length - 1] : null }

async function fetchWeatherData(lat, lon) {
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&hourly=${WEATHER_PARAMS}&timezone=America/Chicago&past_hours=24&forecast_hours=0`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Weather API error: ${res.status}`)
  const data = await res.json()
  const h = data.hourly || {}
  const precipMm = (h.precipitation || []).reduce((sum, v) => sum + (v || 0), 0)
  return {
    precip24hr: Math.round(precipMm * MM_TO_INCHES * 100) / 100,
    tempF: celsiusToFahrenheit(lastVal(h.temperature_2m)),
    humidity: lastVal(h.relative_humidity_2m),
    dewPointF: celsiusToFahrenheit(lastVal(h.dew_point_2m)),
    windSpeedMph: kphToMph(lastVal(h.wind_speed_10m)),
    windDir: lastVal(h.wind_direction_10m),
  }
}

// ── Observation logging ──
async function logObservation(siteId, weather) {
  try {
    await addDoc(collection(db, 'observations'), {
      siteId,
      ...weather,
      timestamp: Timestamp.now(),
    })
  } catch (e) {
    console.error(`Failed to log observation for ${siteId}:`, e)
  }
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms))
}

// ── Hooks ──
function useSites() {
  const [sites, setSites] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async () => {
    try {
      setLoading(true)
      setError(null)
      const data = await loadSites()
      setSites(data)
    } catch (e) {
      setError('Failed to load sites from Firestore. Check your Firebase config.')
      console.error(e)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const add = useCallback(async (site) => {
    const newSite = await addSiteDoc(site)
    setSites(prev => [...prev, newSite])
    return newSite
  }, [])

  const update = useCallback(async (id, data) => {
    await updateSiteDoc(id, data)
    setSites(prev => prev.map(s => s.id === id ? { ...s, ...data } : s))
  }, [])

  const remove = useCallback(async (id) => {
    await deleteSiteDoc(id)
    setSites(prev => prev.filter(s => s.id !== id))
  }, [])

  return { sites, loading, error, reload: load, add, update, remove }
}

function useWeatherData(sites) {
  const [weatherData, setWeatherData] = useState({})
  const [fetching, setFetching] = useState(false)
  const [lastUpdated, setLastUpdated] = useState(null)
  const intervalRef = useRef(null)

  const fetchAll = useCallback(async (sitesToFetch) => {
    if (!sitesToFetch || sitesToFetch.length === 0) return
    setFetching(true)
    const results = {}
    for (let i = 0; i < sitesToFetch.length; i++) {
      const site = sitesToFetch[i]
      try {
        const weather = await fetchWeatherData(site.lat, site.lon)
        results[site.id] = weather
        await logObservation(site.id, weather)
      } catch (e) {
        console.error(`Failed to fetch weather for ${site.name}:`, e)
        results[site.id] = null
      }
      if (i < sitesToFetch.length - 1) await delay(FETCH_DELAY)
    }
    setWeatherData(prev => ({ ...prev, ...results }))
    setLastUpdated(new Date())
    setFetching(false)
  }, [])

  useEffect(() => {
    if (sites.length > 0) fetchAll(sites)
  }, [sites, fetchAll])

  useEffect(() => {
    if (sites.length === 0) return
    intervalRef.current = setInterval(() => fetchAll(sites), REFRESH_INTERVAL)
    return () => clearInterval(intervalRef.current)
  }, [sites, fetchAll])

  const refresh = useCallback(() => fetchAll(sites), [sites, fetchAll])

  return { weatherData, fetching, lastUpdated, refresh }
}

// ── Components ──
function MapUpdater({ center, zoom }) {
  const map = useMap()
  useEffect(() => {
    if (center) map.setView(center, zoom || map.getZoom())
  }, [center, zoom, map])
  return null
}

function SiteRow({ site, weather, onClick, index }) {
  const precip = weather?.precip24hr ?? null
  const cls = precip != null ? getPrecipClass(precip) : ''
  const color = getPrecipColor(cls)
  const barWidth = precip > 0 ? Math.min((precip / 1.0) * 100, 100) : 0

  return (
    <div
      onClick={onClick}
      style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 20px 10px 17px',
        borderBottom: '1px solid #111827',
        borderLeft: `3px solid ${cls ? color : 'transparent'}`,
        cursor: 'pointer',
        transition: 'background 0.15s',
        animation: `fadeIn 0.4s ${index * 30}ms both`,
      }}
      onMouseEnter={e => e.currentTarget.style.background = 'rgba(30, 41, 59, 0.4)'}
      onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <span style={{ fontSize: '13px', fontWeight: 500, color: '#e2e8f0' }}>{site.name}</span>
        <span style={{ fontSize: '10px', color: '#475569', letterSpacing: '0.05em' }}>{site.state}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '4px', minWidth: '80px' }}>
        <span style={{
          fontSize: '15px', fontVariantNumeric: 'tabular-nums',
          color: cls ? color : '#6b7280',
          fontWeight: cls ? 700 : 400,
        }}>
          {precip != null ? precip.toFixed(2) : '---'}
          <span style={{ fontSize: '10px', opacity: 0.6 }}> in</span>
        </span>
        {precip > 0 && (
          <div style={{ width: '60px', height: '3px', background: '#1e293b', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: '2px', width: `${barWidth}%`, background: color, transition: 'width 0.8s ease' }} />
          </div>
        )}
      </div>
    </div>
  )
}

function SiteForm({ initial, onSave, onCancel }) {
  const [name, setName] = useState(initial?.name || '')
  const [state, setState] = useState(initial?.state || '')
  const [lat, setLat] = useState(initial?.lat?.toString() || '')
  const [lon, setLon] = useState(initial?.lon?.toString() || '')
  const [saving, setSaving] = useState(false)

  const parsedLat = parseFloat(lat)
  const parsedLon = parseFloat(lon)
  const validCoords = !isNaN(parsedLat) && !isNaN(parsedLon) && parsedLat >= -90 && parsedLat <= 90 && parsedLon >= -180 && parsedLon <= 180
  const canSave = name.trim() && state.trim() && validCoords

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!canSave) return
    setSaving(true)
    try {
      await onSave({ name: name.trim(), state: state.trim().toUpperCase(), lat: parsedLat, lon: parsedLon })
    } catch (e) {
      console.error('Save failed:', e)
    } finally {
      setSaving(false)
    }
  }

  const inputStyle = {
    background: '#0f172a', border: '1px solid #1e293b', color: '#e2e8f0',
    borderRadius: '6px', padding: '10px 12px', fontSize: '13px',
    fontFamily: 'inherit', width: '100%', outline: 'none',
  }

  return (
    <div style={{ padding: '20px', animation: 'fadeIn 0.3s both' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '20px' }}>
        <button onClick={onCancel} style={{
          background: 'none', border: 'none', color: '#60a5fa',
          fontSize: '14px', cursor: 'pointer', fontFamily: 'inherit', padding: 0,
        }}>&#8592; Back</button>
        <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#f8fafc' }}>
          {initial ? 'Edit Site' : 'Add Site'}
        </h2>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <label style={S.label}>Site Name</label>
          <input style={inputStyle} value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Fargo West" />
        </div>
        <div>
          <label style={S.label}>State</label>
          <input style={inputStyle} value={state} onChange={e => setState(e.target.value)} placeholder="e.g. ND" maxLength={2} />
        </div>
        <div style={{ display: 'flex', gap: '12px' }}>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Latitude</label>
            <input style={inputStyle} type="number" step="any" value={lat} onChange={e => setLat(e.target.value)} placeholder="46.877" />
          </div>
          <div style={{ flex: 1 }}>
            <label style={S.label}>Longitude</label>
            <input style={inputStyle} type="number" step="any" value={lon} onChange={e => setLon(e.target.value)} placeholder="-96.789" />
          </div>
        </div>

        {validCoords && (
          <div style={{ borderRadius: '8px', overflow: 'hidden', border: '1px solid #1e293b', height: '200px', marginTop: '4px' }}>
            <MapContainer center={[parsedLat, parsedLon]} zoom={10} style={{ height: '100%', width: '100%' }} zoomControl={false}>
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
              />
              <Marker position={[parsedLat, parsedLon]} />
              <MapUpdater center={[parsedLat, parsedLon]} zoom={10} />
            </MapContainer>
          </div>
        )}

        <button
          type="submit"
          disabled={!canSave || saving}
          style={{
            background: canSave ? '#2563eb' : '#1e293b',
            color: canSave ? '#fff' : '#475569',
            border: 'none', borderRadius: '6px', padding: '12px',
            fontSize: '13px', fontWeight: 600, fontFamily: 'inherit',
            cursor: canSave ? 'pointer' : 'default',
            transition: 'all 0.15s', marginTop: '4px',
          }}
        >
          {saving ? 'Saving...' : initial ? 'Update Site' : 'Add Site'}
        </button>
      </form>
    </div>
  )
}

function windDirLabel(deg) {
  if (deg == null) return '---'
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
  return dirs[Math.round(deg / 22.5) % 16]
}

function WeatherCard({ label, value, unit }) {
  return (
    <div style={{ background: '#0f172a', borderRadius: '8px', padding: '12px' }}>
      <div style={{ fontSize: '10px', color: '#64748b', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.08em' }}>{label}</div>
      <div style={{ fontSize: '14px', color: '#e2e8f0', fontVariantNumeric: 'tabular-nums' }}>
        {value ?? '---'}{value != null && unit ? <span style={{ fontSize: '10px', opacity: 0.6 }}> {unit}</span> : null}
      </div>
    </div>
  )
}

function SiteDetail({ site, weather, onBack, onEdit, onDelete }) {
  const [confirming, setConfirming] = useState(false)
  const precip = weather?.precip24hr ?? null
  const cls = precip != null ? getPrecipClass(precip) : ''
  const color = getPrecipColor(cls)

  const handleDelete = async () => {
    if (!confirming) { setConfirming(true); return }
    await onDelete(site.id)
  }

  return (
    <div style={{ animation: 'fadeIn 0.3s both' }}>
      <div style={{ padding: '20px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <button onClick={onBack} style={{
            background: 'none', border: 'none', color: '#60a5fa',
            fontSize: '14px', cursor: 'pointer', fontFamily: 'inherit', padding: 0,
          }}>&#8592; Back</button>
          <h2 style={{ fontSize: '15px', fontWeight: 600, color: '#f8fafc' }}>{site.name}</h2>
        </div>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button onClick={onEdit} style={{
            background: 'none', border: '1px solid #334155', color: '#94a3b8',
            borderRadius: '6px', padding: '6px 14px', fontSize: '11px',
            fontFamily: 'inherit', cursor: 'pointer',
          }}>Edit</button>
          <button onClick={handleDelete} style={{
            background: confirming ? '#991b1b' : 'none',
            border: `1px solid ${confirming ? '#991b1b' : '#334155'}`,
            color: confirming ? '#fecaca' : '#94a3b8',
            borderRadius: '6px', padding: '6px 14px', fontSize: '11px',
            fontFamily: 'inherit', cursor: 'pointer',
          }}>{confirming ? 'Confirm' : 'Delete'}</button>
        </div>
      </div>

      <div style={{ height: '250px', borderTop: '1px solid #1e293b', borderBottom: '1px solid #1e293b' }}>
        <MapContainer center={[site.lat, site.lon]} zoom={11} style={{ height: '100%', width: '100%' }} zoomControl={false}>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Marker position={[site.lat, site.lon]} />
        </MapContainer>
      </div>

      <div style={{ padding: '20px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
          <span style={{ fontSize: '11px', color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.1em' }}>24hr Precipitation</span>
          <span style={{
            fontSize: '28px', fontWeight: 700, fontVariantNumeric: 'tabular-nums',
            color: cls ? color : '#6b7280',
          }}>
            {precip != null ? precip.toFixed(2) : '---'}
            <span style={{ fontSize: '13px', opacity: 0.6, fontWeight: 400 }}> in</span>
          </span>
        </div>
        {precip > 0 && (
          <div style={{ width: '100%', height: '4px', background: '#1e293b', borderRadius: '2px', overflow: 'hidden' }}>
            <div style={{ height: '100%', borderRadius: '2px', width: `${Math.min((precip / 1.0) * 100, 100)}%`, background: color, transition: 'width 0.8s ease' }} />
          </div>
        )}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px', marginTop: '4px' }}>
          <WeatherCard label="Temperature" value={weather?.tempF} unit="°F" />
          <WeatherCard label="Humidity" value={weather?.humidity != null ? Math.round(weather.humidity) : null} unit="%" />
          <WeatherCard label="Dew Point" value={weather?.dewPointF} unit="°F" />
          <WeatherCard label="Wind Speed" value={weather?.windSpeedMph} unit="mph" />
          <WeatherCard label="Wind Direction" value={weather?.windDir != null ? `${windDirLabel(weather.windDir)} (${Math.round(weather.windDir)}°)` : null} unit="" />
          <WeatherCard label="Coordinates" value={`${site.lat.toFixed(3)}, ${site.lon.toFixed(3)}`} unit="" />
        </div>
      </div>
    </div>
  )
}

// ── Styles ──
const S = {
  label: {
    display: 'block', fontSize: '10px', color: '#64748b',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    marginBottom: '6px', fontWeight: 600,
  },
}

const CSS = `
  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    background: #0a0f1a;
    font-family: 'JetBrains Mono', 'SF Mono', monospace;
    color: #e2e8f0;
    -webkit-font-smoothing: antialiased;
  }

  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(4px); }
    to { opacity: 1; transform: translateY(0); }
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  ::-webkit-scrollbar { width: 6px; }
  ::-webkit-scrollbar-track { background: #0a0f1a; }
  ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
  ::-webkit-scrollbar-thumb:hover { background: #334155; }

  .leaflet-tile-pane { filter: brightness(0.7) contrast(1.1) saturate(0.3); }
  .leaflet-container { background: #0a0f1a !important; }
`

// ── App ──
export default function App() {
  const { sites, loading, error, reload, add, update, remove } = useSites()
  const { weatherData, fetching, lastUpdated, refresh } = useWeatherData(sites)

  const [view, setView] = useState('list')
  const [selectedId, setSelectedId] = useState(null)
  const [filter, setFilter] = useState('all')
  const [sort, setSort] = useState('name')

  const selectedSite = sites.find(s => s.id === selectedId)

  const states = useMemo(() => {
    const set = new Set(sites.map(s => s.state))
    return ['all', ...Array.from(set).sort()]
  }, [sites])

  const filteredSites = useMemo(() => {
    let list = [...sites]
    if (filter !== 'all') list = list.filter(s => s.state === filter)
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name))
    else if (sort === 'precip') list.sort((a, b) => (weatherData[b.id]?.precip24hr ?? -1) - (weatherData[a.id]?.precip24hr ?? -1))
    else if (sort === 'state') list.sort((a, b) => a.state.localeCompare(b.state) || a.name.localeCompare(b.name))
    return list
  }, [sites, filter, sort, precipData])

  const precipSiteCount = sites.filter(s => (weatherData[s.id]?.precip24hr ?? 0) > 0).length

  const handleAdd = async (data) => {
    await add(data)
    setView('list')
  }

  const handleUpdate = async (data) => {
    await update(selectedId, data)
    setView('detail')
  }

  const handleDelete = async (id) => {
    await remove(id)
    setView('list')
    setSelectedId(null)
  }

  return (
    <>
      <style>{CSS}</style>
      <div style={{ maxWidth: '640px', margin: '0 auto', minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>

        {view === 'list' && (
          <>
            <header style={{
              padding: '24px 20px 16px', borderBottom: '1px solid #1e293b',
              background: 'linear-gradient(180deg, #0f172a 0%, #0a0f1a 100%)',
              position: 'sticky', top: 0, zIndex: 10,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '12px' }}>
                <div>
                  <h1 style={{ fontSize: '18px', fontWeight: 700, letterSpacing: '0.15em', color: '#f8fafc' }}>PRECIP MONITOR</h1>
                  <p style={{ marginTop: '4px', fontSize: '11px', color: '#64748b', letterSpacing: '0.02em' }}>
                    {loading ? 'Loading sites...' :
                      `${sites.length} site${sites.length !== 1 ? 's' : ''}` +
                      (precipSiteCount > 0 ? ` \u00B7 ${precipSiteCount} reporting precipitation` : sites.length > 0 ? ' \u00B7 No precipitation detected' : '')}
                  </p>
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button onClick={() => { refresh(); reload() }} title="Refresh" style={{
                    background: 'none', border: '1px solid #334155', color: '#94a3b8',
                    borderRadius: '6px', width: '36px', height: '36px', fontSize: '18px',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'inherit', transition: 'all 0.15s',
                    animation: fetching ? 'spin 1s linear infinite' : 'none',
                  }}
                    onMouseEnter={e => { e.currentTarget.style.borderColor = '#60a5fa'; e.currentTarget.style.color = '#60a5fa' }}
                    onMouseLeave={e => { e.currentTarget.style.borderColor = '#334155'; e.currentTarget.style.color = '#94a3b8' }}
                  >&#x21BB;</button>
                  <button onClick={() => setView('add')} title="Add site" style={{
                    background: '#2563eb', border: 'none', color: '#fff',
                    borderRadius: '6px', width: '36px', height: '36px', fontSize: '20px',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    fontFamily: 'inherit', fontWeight: 300, transition: 'all 0.15s',
                  }}
                    onMouseEnter={e => e.currentTarget.style.background = '#3b82f6'}
                    onMouseLeave={e => e.currentTarget.style.background = '#2563eb'}
                  >+</button>
                </div>
              </div>

              {sites.length > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                  <div style={{ display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                    {states.map(st => (
                      <button key={st} onClick={() => setFilter(st)} style={{
                        background: filter === st ? '#1e293b' : 'none',
                        border: `1px solid ${filter === st ? '#334155' : '#1e293b'}`,
                        color: filter === st ? '#e2e8f0' : '#64748b',
                        borderRadius: '4px', padding: '3px 10px', fontSize: '10px',
                        fontFamily: 'inherit', cursor: 'pointer', letterSpacing: '0.05em',
                        transition: 'all 0.15s',
                      }}>{st === 'all' ? 'All' : st}</button>
                    ))}
                  </div>
                  <select value={sort} onChange={e => setSort(e.target.value)} style={{
                    background: '#0f172a', border: '1px solid #1e293b', color: '#94a3b8',
                    borderRadius: '4px', padding: '3px 8px', fontSize: '10px', fontFamily: 'inherit', cursor: 'pointer',
                  }}>
                    <option value="name">Sort: Name</option>
                    <option value="precip">Sort: Precip</option>
                    <option value="state">Sort: State</option>
                  </select>
                </div>
              )}
            </header>

            {error && (
              <div style={{ padding: '16px 20px', color: '#f87171', fontSize: '12px', borderBottom: '1px solid #1e293b' }}>
                {error}
              </div>
            )}

            {sites.length > 0 && (
              <div style={{
                display: 'flex', justifyContent: 'space-between', padding: '10px 20px 6px',
                fontSize: '9px', fontWeight: 600, textTransform: 'uppercase',
                letterSpacing: '0.12em', color: '#475569', borderBottom: '1px solid #1e293b',
              }}>
                <span>Site</span>
                <span>24hr Precip</span>
              </div>
            )}

            <main style={{ flex: 1 }}>
              {loading ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: '#475569', fontSize: '12px' }}>
                  Loading sites...
                </div>
              ) : sites.length === 0 ? (
                <div style={{ padding: '60px 20px', textAlign: 'center' }}>
                  <div style={{ fontSize: '32px', marginBottom: '12px', opacity: 0.4 }}>&#127790;</div>
                  <div style={{ color: '#64748b', fontSize: '13px', marginBottom: '4px' }}>No sites yet</div>
                  <div style={{ color: '#475569', fontSize: '11px' }}>
                    Tap <span style={{ color: '#60a5fa' }}>+</span> to add your first monitoring site
                  </div>
                </div>
              ) : filteredSites.length === 0 ? (
                <div style={{ padding: '40px 20px', textAlign: 'center', color: '#475569', fontSize: '12px' }}>
                  No sites match the selected filter
                </div>
              ) : (
                filteredSites.map((site, i) => (
                  <SiteRow
                    key={site.id}
                    site={site}
                    weather={weatherData[site.id] ?? null}
                    index={i}
                    onClick={() => { setSelectedId(site.id); setView('detail') }}
                  />
                ))
              )}
            </main>

            <footer style={{
              padding: '12px 20px', borderTop: '1px solid #1e293b',
              display: 'flex', justifyContent: 'space-between',
              fontSize: '10px', color: '#475569', marginTop: 'auto',
            }}>
              <span>{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
              <span>Source: Open-Meteo</span>
            </footer>
          </>
        )}

        {view === 'detail' && selectedSite && (
          <SiteDetail
            site={selectedSite}
            weather={weatherData[selectedSite.id] ?? null}
            onBack={() => setView('list')}
            onEdit={() => setView('edit')}
            onDelete={handleDelete}
          />
        )}

        {view === 'add' && (
          <SiteForm onSave={handleAdd} onCancel={() => setView('list')} />
        )}

        {view === 'edit' && selectedSite && (
          <SiteForm initial={selectedSite} onSave={handleUpdate} onCancel={() => setView('detail')} />
        )}
      </div>
    </>
  )
}
