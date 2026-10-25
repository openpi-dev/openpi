import {
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@astryxdesign/core/DropdownMenu";

export interface SettingsSelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function SettingsSelect({
  id,
  name,
  label,
  value,
  options,
  disabled = false,
  onChange,
  className,
  menuWidth = "min(300px, calc(100vw - 32px))",
}: {
  id?: string;
  name?: string;
  label: string;
  value: string;
  options: readonly SettingsSelectOption[];
  disabled?: boolean;
  onChange: (value: string) => void;
  className?: string;
  menuWidth?: number | string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <DropdownMenu
      button={{
        id,
        name,
        label: selected?.label ?? value,
        "aria-label": label,
        variant: "secondary",
        size: "sm",
        className: `settings-select-menu-trigger${className ? ` ${className}` : ""}`,
        isDisabled: disabled,
      }}
      className="settings-select-menu"
      menuWidth={menuWidth}
      alignment="end"
    >
      <DropdownMenuRadioGroup
        value={value}
        label={label}
        onChange={(next: string) => {
          if (next !== value) onChange(next);
        }}
      >
        {options.map((option) => (
          <DropdownMenuRadioItem
            key={option.value}
            value={option.value}
            label={option.label}
            isDisabled={disabled || option.disabled}
            description={
              option.description ? (
                <span className="settings-select-option-description">
                  {option.description}
                </span>
              ) : undefined
            }
          />
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenu>
  );
}
