import { AT, CH, DE, ES, FI, FR, GB, IE, IT, NL, NO, SE } from "country-flag-icons/react/3x2";

type FlagComponent = typeof DE;

const flagByCountryCode: Record<string, FlagComponent> = {
  AT,
  CH,
  DE,
  ES,
  FI,
  FR,
  GB,
  IE,
  IT,
  NL,
  NO,
  SE
};

interface CountryFlagProps {
  code: string;
  label: string;
  className: string;
  fallback: string;
}

export function CountryFlag({ code, label, className, fallback }: CountryFlagProps) {
  const Flag = flagByCountryCode[code.toUpperCase()];
  if (!Flag) {
    return <span className={className} role="img" aria-label={`Flagge ${label}`}>{fallback}</span>;
  }

  return <Flag className={className} role="img" aria-label={`Flagge ${label}`} />;
}
