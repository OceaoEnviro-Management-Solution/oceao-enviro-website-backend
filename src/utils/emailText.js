// Email subjects are plain text: raw value, line breaks removed so headers cannot be injected.
const singleLine = (value = "") => String(value).replace(/[\r\n]+/g, " ").trim();

const truncate = (value = "", max = 100) => {
    const text = String(value);
    return text.length > max ? `${text.slice(0, max)}...` : text;
};

export { singleLine, truncate };
