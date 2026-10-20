import { useI18n } from '../../i18n.js';

// Live View item resolution (Nx Witness style): Auto picks high or low by tile size
const qualities = [
  { value: 'auto', title: 'Auto: high quality when this tile is large (over 172px tall), alone or fullscreen; low quality otherwise' },
  { value: 'high', labelKey: 'live.highQuality', titleKey: 'live.highQualityTitle' },
  { value: 'low', labelKey: 'live.lowQuality', titleKey: 'live.lowQualityTitle' },
];

/**
 * @param {Object} props
 * @param {'auto'|'high'|'low'} props.value  the tile's setting
 * @param {'high'|'low'} [props.effectiveQuality]  stream in use (shown on Auto)
 */
export function StreamQualitySelector({ value, effectiveQuality, onChange, disabled = false }) {
  const { t } = useI18n();

  return (
    <div
      className="stream-quality-selector"
      role="group"
      aria-label={t('live.streamQuality')}
      title={t('live.streamQuality')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: '26px',
        padding: '1px',
        borderRadius: '5px',
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        border: '1px solid rgba(255, 255, 255, 0.12)',
        overflow: 'hidden',
        flexShrink: 0,
      }}
    >
      {qualities.map((quality) => {
        const active = value === quality.value;

        return (
          <button
            key={quality.value}
            type="button"
            aria-pressed={active}
            data-item-quality={quality.value}
            disabled={disabled}
            onClick={() => onChange?.(quality.value)}
            title={quality.title || t(quality.titleKey)}
            style={{
              minWidth: '32px',
              height: '22px',
              padding: '0 6px',
              border: 'none',
              borderRadius: '4px',
              backgroundColor: active ? '#2563eb' : 'transparent',
              color: 'white',
              cursor: disabled ? 'not-allowed' : 'pointer',
              fontSize: '11px',
              fontWeight: active ? '700' : '500',
              lineHeight: '22px',
              opacity: disabled ? 0.6 : 1,
              transition: 'background-color 0.15s ease',
            }}
          >
            {quality.value === 'auto'
              ? (active && effectiveQuality ? `Auto·${effectiveQuality === 'high' ? 'Hi' : 'Lo'}` : 'Auto')
              : t(quality.labelKey)}
          </button>
        );
      })}
    </div>
  );
}
