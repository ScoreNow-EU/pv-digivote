import * as flagsByCountryCode from "country-flag-icons/react/3x2";

type FlagComponent = typeof flagsByCountryCode.DE;

interface CountryFlagProps {
  code: string;
  label: string;
  className: string;
  fallback: string;
}

export function CountryFlag({ code, label, className, fallback }: CountryFlagProps) {
  const Flag = (flagsByCountryCode as Record<string, FlagComponent | undefined>)[code.toUpperCase()];
  if (!Flag) {
    return <span className={className} role="img" aria-label={`Flagge ${label}`}>{fallback}</span>;
  }

  return <Flag className={className} role="img" aria-label={`Flagge ${label}`} />;
}
