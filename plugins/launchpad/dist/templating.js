export function render(template, vars) {
    return template.replace(/\{\{(\w+)\}\}/g, (_match, key) => {
        if (!(key in vars))
            throw new Error(`render: missing template variable {{${key}}}`);
        return vars[key];
    });
}
