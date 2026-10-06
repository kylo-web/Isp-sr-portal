const express = require('express');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public'));

app.get('/api/get-customer/:id', (req, res) => {
    const customerId = req.params.id;
    const mockDatabase = {
        'Tty01072': 'Min thiha',
        'Tty00001': 'Kyaw Gyi',
        'Tty00002': 'Aung Aung'
    };

    const customerName = mockDatabase[customerId];

    if (customerName) {
        res.json({ success: true, username: customerName });
    } else {
        res.json({ success: false, message: 'Customer ID မရှိပါ' });
    }
});

app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
