'use client'

/**
 * Cold-state preparation wizard for the /demo console: certified preset,
 * compiled Forge/Hardhat artifact, or an already-deployed local-L1 contract.
 *
 * Split out of `components/long-running-demo.tsx` unchanged.
 */

import { CircleAlert, FileCode2, Link2, LoaderCircle, Sparkles, X, Zap } from 'lucide-react'
import { useState } from 'react'
import { idempotencyKey, parseConstructorArgs } from '@/lib/demo-console'
import { api, type Preset } from '@/components/demo-console/api'
import styles from '../../app/demo/demo.module.css'

export function TemplateWizard({
  presets,
  onClose,
  onCreated,
}: {
  presets: Preset[]
  onClose: () => void
  onCreated: () => Promise<void>
}) {
  const [mode, setMode] = useState<'preset' | 'artifact' | 'attached'>('preset')
  const [presetId, setPresetId] = useState(presets[0]?.id ?? 'shop')
  const [name, setName] = useState('Presentation room template')
  const [artifact, setArtifact] = useState<Record<string, unknown> | null>(null)
  const [constructorArgs, setConstructorArgs] = useState('[]')
  const [attachedAddress, setAttachedAddress] = useState('')
  const [state, setState] = useState<Array<{ label: string; slot: string; value: string; mode: string }>>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadArtifact = async (file: File) => {
    try {
      const parsed = JSON.parse(await file.text()) as {
        contractName?: string
        abi?: unknown[]
        bytecode?: unknown
        deployedBytecode?: unknown
        storageLayout?: { storage?: Array<{ label?: string; slot?: string }> }
      }
      if (!Array.isArray(parsed.abi)) throw new Error('The artifact has no ABI.')
      setArtifact(parsed)
      setName(parsed.contractName ? `${parsed.contractName} room` : file.name.replace(/\.json$/i, ''))
      setState(
        (parsed.storageLayout?.storage ?? []).slice(0, 32).map((item, index) => ({
          label: item.label || `slot ${item.slot ?? index}`,
          slot: item.slot ?? String(index),
          value: '0',
          mode: 'ROOM_LOCAL',
        })),
      )
      setError(null)
    } catch (caught) {
      setArtifact(null)
      setError(caught instanceof Error ? caught.message : 'The artifact could not be read.')
    }
  }

  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const payload =
        mode === 'preset'
          ? { name, presetId }
          : mode === 'artifact'
            ? {
                name,
                contractMode: 'artifact',
                artifact,
                constructorArgs: parseConstructorArgs(constructorArgs),
                selectedState: state,
              }
            : {
                name,
                contractMode: 'attached',
                attachedAddress,
                artifact,
                selectedState: state,
              }
      await api('/demo/v1/templates', {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey('template') },
        body: JSON.stringify(payload),
      })
      await onCreated()
      onClose()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Template preparation did not start.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={styles.modalBackdrop} role="presentation" onMouseDown={onClose}>
      <section
        className={styles.wizard}
        role="dialog"
        aria-modal="true"
        aria-labelledby="template-wizard-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className={styles.wizardHeader}>
          <div>
            <span className={styles.eyebrow}>Cold-state preparation</span>
            <h2 id="template-wizard-title">Create a deployable room template</h2>
          </div>
          <button className={styles.iconButton} onClick={onClose} aria-label="Close">
            <X size={19} />
          </button>
        </header>
        <div className={styles.modeSwitch}>
          <button className={mode === 'preset' ? styles.modeActive : ''} onClick={() => setMode('preset')}>
            <Sparkles size={16} /> Certified preset
          </button>
          <button className={mode === 'artifact' ? styles.modeActive : ''} onClick={() => setMode('artifact')}>
            <FileCode2 size={16} /> Compiled artifact
          </button>
          <button className={mode === 'attached' ? styles.modeActive : ''} onClick={() => setMode('attached')}>
            <Link2 size={16} /> Attached L1 contract
          </button>
        </div>
        <label className={styles.field}>
          <span>Template name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        {mode === 'preset' ? (
          <div className={styles.presetGrid}>
            {presets.map((preset) => (
              <button
                key={preset.id}
                className={`${styles.presetChoice} ${presetId === preset.id ? styles.presetSelected : ''}`}
                onClick={() => {
                  setPresetId(preset.id)
                  setName(`${preset.name} template`)
                }}
              >
                <span>{preset.name}</span>
                <small>{preset.summary}</small>
                <em>{preset.participantCapacity.toLocaleString()} registered users</em>
              </button>
            ))}
          </div>
        ) : (
          <>
            <label className={styles.uploadZone}>
              <FileCode2 size={24} />
              <span>{artifact ? String(artifact.contractName ?? 'Compiled artifact loaded') : 'Choose Forge or Hardhat artifact'}</span>
              <small>ABI, creation bytecode, deployed bytecode, and storage layout</small>
              <input type="file" accept=".json,application/json" onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void loadArtifact(file)
              }} />
            </label>
            {mode === 'artifact' ? (
              <label className={styles.field}>
                <span>Constructor arguments · JSON array</span>
                <input value={constructorArgs} onChange={(event) => setConstructorArgs(event.target.value)} />
              </label>
            ) : (
              <label className={styles.field}>
                <span>Existing local-L1 contract address</span>
                <input value={attachedAddress} onChange={(event) => setAttachedAddress(event.target.value)} placeholder="0x..." />
              </label>
            )}
            {state.length > 0 ? (
              <div className={styles.stateTable}>
                <div className={styles.stateHeader}>
                  <span>State variable</span><span>Initial value</span><span>Room policy</span>
                </div>
                {state.map((item, index) => (
                  <div className={styles.stateRow} key={`${item.slot}-${item.label}`}>
                    <span><strong>{item.label}</strong><small>slot {item.slot}</small></span>
                    <input
                      value={item.value}
                      onChange={(event) => setState((current) => current.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, value: event.target.value } : row,
                      ))}
                    />
                    <select
                      value={item.mode}
                      onChange={(event) => setState((current) => current.map((row, rowIndex) =>
                        rowIndex === index ? { ...row, mode: event.target.value } : row,
                      ))}
                    >
                      <option value="ROOM_LOCAL">Writable in room</option>
                      <option value="INITIAL_WITNESS">Fixed initial witness</option>
                      <option value="L1_MIRROR">Authenticated L1 mirror</option>
                      <option value="EXCLUDED">Excluded</option>
                    </select>
                  </div>
                ))}
              </div>
            ) : null}
          </>
        )}
        {error ? <div className={styles.errorBanner}><CircleAlert size={16} />{error}</div> : null}
        <footer className={styles.wizardFooter}>
          <span>Cold proving uses the single queued CUDA worker.</span>
          <button
            className={styles.primaryButton}
            disabled={busy || (mode !== 'preset' && !artifact) || (mode === 'attached' && !/^0x[0-9a-fA-F]{40}$/.test(attachedAddress))}
            onClick={() => void submit()}
          >
            {busy ? <LoaderCircle className={styles.spin} size={17} /> : <Zap size={17} />}
            Validate and prepare
          </button>
        </footer>
      </section>
    </div>
  )
}
