# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-02-11

### Added
- Full weather data logging to Firestore `observations` collection (temperature, humidity, dew point, wind speed, wind direction, precipitation)
- Weather detail cards in site detail view showing all 6 parameters
- Unit conversions: Celsius to Fahrenheit, km/h to mph, degrees to compass labels

### Changed
- Refresh cycle from 15 minutes to 1 hour
- Open-Meteo query expanded from precipitation-only to all weather parameters

## [1.0.0] - 2026-02-11

### Added
- Site management: add, edit, delete agricultural monitoring sites with GPS coordinates
- Real-time 24hr precipitation data from Open-Meteo API (free, no key required)
- Leaflet maps with darkened tiles in site form (preview) and detail views
- Firestore persistence for sites collection
- Auto-refresh weather data every 15 minutes
- Filter by state, sort by name/precip/state
- Dark monospace UI with JetBrains Mono font matching preview design
- Precipitation color coding: light (blue), moderate (medium blue), heavy (dark blue)
- Sequential API fetches with 100ms delay for rate limiting
- GitHub Actions deploy workflow for GitHub Pages
- Empty state with prompt to add first site
- Loading and error states for Firestore connectivity
