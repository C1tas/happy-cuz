import React, { useState } from 'react';
import { Text, useInput, Box } from 'ink';

export interface ResumeOptions {
    startingMode: 'local' | 'remote';
    yolo: boolean;
    remoteColor: boolean;
    noAltScreen: boolean;
}

interface ResumeOptionsSelectorProps {
    sessionId: string;
    onSelect: (options: ResumeOptions) => void;
    onCancel: () => void;
}

interface OptionDef {
    key: keyof ResumeOptions;
    label: string;
    type: 'toggle' | 'cycle';
    values?: string[];
    defaultValue: boolean | string;
}

const optionDefs: OptionDef[] = [
    { key: 'startingMode', label: 'Starting Mode', type: 'cycle', values: ['local', 'remote'], defaultValue: 'local' },
    { key: 'yolo', label: 'Yolo Mode (bypass permissions)', type: 'toggle', defaultValue: false },
    { key: 'remoteColor', label: 'Remote Color Output', type: 'toggle', defaultValue: false },
    { key: 'noAltScreen', label: 'Disable Alt Screen Buffer', type: 'toggle', defaultValue: false },
];

export const ResumeOptionsSelector: React.FC<ResumeOptionsSelectorProps> = ({ sessionId, onSelect, onCancel }) => {
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [values, setValues] = useState<Record<string, boolean | string>>(() => {
        const init: Record<string, boolean | string> = {};
        for (const def of optionDefs) {
            init[def.key] = def.defaultValue;
        }
        return init;
    });

    // Last row is the "Start" button
    const totalRows = optionDefs.length + 1;

    useInput((input, key) => {
        if (key.upArrow) {
            setSelectedIndex(prev => Math.max(0, prev - 1));
        } else if (key.downArrow) {
            setSelectedIndex(prev => Math.min(totalRows - 1, prev + 1));
        } else if (key.return || input === ' ') {
            if (selectedIndex === optionDefs.length) {
                // Start button
                onSelect({
                    startingMode: values.startingMode as 'local' | 'remote',
                    yolo: values.yolo as boolean,
                    remoteColor: values.remoteColor as boolean,
                    noAltScreen: values.noAltScreen as boolean,
                });
            } else {
                // Toggle/cycle the option
                const def = optionDefs[selectedIndex];
                setValues(prev => {
                    if (def.type === 'toggle') {
                        return { ...prev, [def.key]: !prev[def.key] };
                    }
                    // cycle
                    const vals = def.values!;
                    const idx = vals.indexOf(prev[def.key] as string);
                    return { ...prev, [def.key]: vals[(idx + 1) % vals.length] };
                });
            }
        } else if (key.escape || (key.ctrl && input === 'c')) {
            onCancel();
        }
    });

    return (
        <Box flexDirection="column" paddingY={1}>
            <Box marginBottom={1}>
                <Text bold>Resume Session </Text>
                <Text color="cyan">{sessionId.substring(0, 8)}</Text>
            </Box>

            <Box flexDirection="column">
                {optionDefs.map((def, index) => {
                    const isSelected = selectedIndex === index;
                    const val = values[def.key];
                    const displayValue = def.type === 'toggle'
                        ? (val ? 'ON' : 'OFF')
                        : String(val);
                    const valueColor = def.type === 'toggle'
                        ? (val ? 'green' : 'gray')
                        : 'yellow';

                    return (
                        <Box key={def.key}>
                            <Text color={isSelected ? 'cyan' : 'gray'}>
                                {isSelected ? '› ' : '  '}
                                {def.label}:{' '}
                            </Text>
                            <Text color={valueColor} bold={isSelected}>
                                {displayValue}
                            </Text>
                        </Box>
                    );
                })}

                {/* Start button */}
                <Box marginTop={1}>
                    <Text color={selectedIndex === optionDefs.length ? 'green' : 'gray'} bold={selectedIndex === optionDefs.length}>
                        {selectedIndex === optionDefs.length ? '› ' : '  '}
                        Start Session
                    </Text>
                </Box>
            </Box>

            <Box marginTop={1}>
                <Text dimColor>↑↓ navigate, Space/Enter toggle or start, Esc cancel</Text>
            </Box>
        </Box>
    );
};
